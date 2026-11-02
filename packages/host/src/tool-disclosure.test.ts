import { describe, expect, it } from 'vitest'
import type { ToolSchema } from '@agent-kernel/kernel'
import { activateTools, intentActivatedTools, searchToolCatalog, toolCatalogRevision, visibleTools, withRequiredToolIntent } from './tool-disclosure.js'

const tools: ToolSchema[] = [
  { name: 'tool_search', description: 'discover', inputSchema: {}, requiresApproval: false },
  { name: 'tool_describe', description: 'describe', inputSchema: {}, requiresApproval: false },
  { name: 'read_file', description: 'read source', inputSchema: {}, requiresApproval: false },
  { name: 'todo_graph', description: 'plan work', inputSchema: {}, requiresApproval: false },
  { name: 'write_file', description: 'write source files', inputSchema: {}, requiresApproval: true, version: '1.0.0', schemaHash: 'sha256:w' },
  { name: 'webfetch', description: 'fetch a web page over network', inputSchema: {}, requiresApproval: false },
  { name: 'websearch', description: 'search the web', inputSchema: {}, requiresApproval: false },
]

describe('progressive Tool disclosure', () => {
  it('creates a stable catalog revision from identity fields', () => {
    expect(toolCatalogRevision(tools)).toBe(toolCatalogRevision(tools.map((tool) => ({ ...tool }))))
    expect(toolCatalogRevision(tools)).not.toBe(toolCatalogRevision(tools.map((tool) => tool.name === 'write_file' ? { ...tool, version: '2.0.0' } : tool)))
  })

  it('keeps every configured Tool visible in catalog order regardless of activation', () => {
    expect(visibleTools(tools, 'progressive', new Set()).map((tool) => tool.name)).toEqual(tools.map((tool) => tool.name))
    expect(visibleTools(tools, 'progressive', new Set(['webfetch']))).toEqual(visibleTools(tools, 'progressive', new Set()))
    expect(visibleTools(tools, 'legacy_full', new Set()).map((tool) => tool.name)).toEqual(tools.map((tool) => tool.name))
  })

  it('retains discovery when the entire locked catalog is activated', () => {
    const coreOnly = tools.filter((tool) => ['tool_search', 'tool_describe', 'read_file', 'todo_graph'].includes(tool.name))
    expect(visibleTools(coreOnly, 'progressive', new Set()).map((tool) => tool.name)).toEqual(coreOnly.map((tool) => tool.name))
    expect(visibleTools(tools, 'progressive', new Set(['write_file', 'webfetch', 'websearch'])).map((tool) => tool.name))
      .toEqual(tools.map((tool) => tool.name))
  })

  it('fingerprints actual descriptions and schemas even with unchanged declared hashes', () => {
    const revision = toolCatalogRevision(tools)
    expect(toolCatalogRevision(tools.map((tool) => ({ ...tool, description: `${tool.description}!` })))).not.toBe(revision)
    expect(toolCatalogRevision(tools.map((tool) => ({ ...tool, inputSchema: { properties: { query: { type: 'string' } } } })))).not.toBe(revision)
    const schema = { type: 'object', properties: { path: { type: 'string', description: 'path' } } }
    const reordered = { properties: { path: { description: 'path', type: 'string' } }, type: 'object' }
    expect(toolCatalogRevision([{ ...tools[0]!, inputSchema: schema }])).toBe(toolCatalogRevision([{ ...tools[0]!, inputSchema: reordered }]))
    expect(toolCatalogRevision(tools)).not.toBe(toolCatalogRevision([...tools].reverse()))
  })

  it('discloses websearch for explicit Chinese and English network research intent', () => {
    const message = (text: string) => [{ role: 'user' as const, content: [{ type: 'text' as const, text }] }]
    expect([...intentActivatedTools(tools, message('请联网检索最新资料并给出来源链接'))]).toEqual(['websearch'])
    expect([...intentActivatedTools(tools, message('Search the web for current information'))]).toEqual(['websearch'])
    expect([...intentActivatedTools(tools, message('Summarize this paragraph'))]).toEqual([])
  })

  it('searches purpose and activates only locked names', () => {
    expect(searchToolCatalog(tools, 'network page')[0]?.name).toBe('webfetch')
    expect([...activateTools(tools, new Set(), ['write_file'])]).toEqual(['write_file'])
    expect(() => activateTools(tools, new Set(), ['unknown'])).toThrow(/locked catalog/)
  })
  it('upgrades old locked tool schemas with a required intention at disclosure time', () => {
    const old = { name: 'read_file', description: 'read', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }, requiresApproval: false }
    const upgraded = withRequiredToolIntent(old)
    expect((upgraded.inputSchema.properties as Record<string, unknown>)._intent).toMatchObject({ type: 'string', minLength: 12, maxLength: 240 })
    expect(upgraded.inputSchema.required).toEqual(['path', '_intent'])
    expect(old.inputSchema).toEqual({ type: 'object', properties: { path: { type: 'string' } }, required: ['path'] })
    expect(withRequiredToolIntent(upgraded)).toBe(upgraded)
  })

})
