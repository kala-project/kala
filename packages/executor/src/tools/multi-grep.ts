import type { Tool } from './registry.js'
import { ToolError, throwIfAborted } from './registry.js'
import { parseSearchPage } from './search-page.js'
import { grepTool } from './grep.js'
import { optionalString, requireString } from './schema.js'

const MAX_SEARCHES = 20
const MODES = new Set(['content', 'files_with_matches', 'count'])

type Search = Record<string, unknown> & { pattern: string }

export const multiGrepTool: Tool = {
  name: 'multi_grep',
  async run(input, ctx) {
    const searches = parseSearches(input)
    const chunks: string[] = []
    let failed = 0
    for (let index = 0; index < searches.length; index += 1) {
      throwIfAborted(ctx)
      const search = searches[index]!
      try {
        const result = await grepTool.run(search, ctx)
        chunks.push(`===== search[${index}] =====\n${result}`)
      } catch (error) {
        throwIfAborted(ctx)
        if (!(error instanceof ToolError) || error.code === 'ECANCELED') throw error
        failed++
        chunks.push(`===== search[${index}] (failed) =====\nERROR: ${error.message}`)
      }
    }
    // Do not impose a second shared budget here. Every child is exactly the
    // ordinary grep result. The executor-wide overflow layer preserves the
    // complete aggregate when it is too large for an inline response.
    const content = chunks.join('\n\n')
    if (failed) throw new ToolError('EPARTIAL', `${failed}/${searches.length} searches failed; successful sections are preserved.\n\n${content}`)
    return content
  },
}

function parseSearches(input: Record<string, unknown>): Search[] {
  const raw = input['searches']
  if (!Array.isArray(raw)) throw new ToolError('EINVAL', 'missing or non-array field "searches"')
  if (raw.length === 0) throw new ToolError('EINVAL', 'searches must not be empty')
  if (raw.length > MAX_SEARCHES) throw new ToolError('E2BIG', `multi_grep supports at most ${MAX_SEARCHES} searches`)
  return raw.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new ToolError('EINVAL', `searches[${index}] must be an object`)
    const record = item as Record<string, unknown>
    parseSearchPage(record)
    optionalString(record, 'path')
    optionalString(record, 'glob')
    const pattern = requireString(record, 'pattern')
    try { new RegExp(pattern, record['case_insensitive'] === true ? 'i' : '') } catch { throw new ToolError('EINVAL', `invalid regex in searches[${index}]`) }
    const mode = optionalString(record, 'output_mode')
    if (mode !== undefined && !MODES.has(mode)) throw new ToolError('EINVAL', `invalid output_mode in searches[${index}]: ${mode}`)
    if (record['case_insensitive'] !== undefined && typeof record['case_insensitive'] !== 'boolean') throw new ToolError('EINVAL', `searches[${index}].case_insensitive must be boolean`)
    return { ...record, pattern }
  })
}
