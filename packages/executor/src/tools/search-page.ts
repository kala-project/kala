import { ToolError } from './registry.js'

export function parseSearchPage(input: Record<string, unknown>) {
  const offset = input['offset'] === undefined ? 0 : input['offset']
  const limit = input['limit'] === undefined ? 1000 : input['limit']
  if (!Number.isSafeInteger(offset) || (offset as number) < 0
      || !Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > 1000) {
    throw new ToolError('EINVAL', 'offset must be a non-negative safe integer; limit must be an integer from 1 to 1000')
  }
  return { offset: offset as number, limit: limit as number, explicit: input['offset'] !== undefined || input['limit'] !== undefined }
}

export function searchPageFooter(page: ReturnType<typeof parseSearchPage>, returned: number, more: boolean, incomplete: boolean): string[] {
  const lines: string[] = []
  if (page.explicit || more || incomplete) {
    lines.push(`Search page: offset=${page.offset}; limit=${page.limit}; returned=${returned}; next_offset=${more ? page.offset + returned : 'none observed'}`)
  }
  if (more) lines.push('... and more matches; continue with next_offset and the same pattern, scope and limit (unchanged workspace).')
  if (incomplete) lines.push('Scan incomplete: traversal limit or unreadable files/directories; narrow path/glob. Pagination cannot recover unscanned files; do not infer exhaustive results.')
  return lines
}
