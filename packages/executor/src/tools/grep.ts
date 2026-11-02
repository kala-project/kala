import { readFile, readdir, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'
import picomatch from 'picomatch'

import { SandboxError } from '../sandbox.js'
import type { Tool } from './registry.js'
import { parseSearchPage, searchPageFooter } from './search-page.js'
import { ToolError, throwIfAborted } from './registry.js'
import { optionalBoolean, optionalString, requireString } from './schema.js'

const MAX_FILES = 10_000
const MAX_WALK = 100_000

type OutputMode = 'files_with_matches' | 'count' | 'content'

function parseMode(input: Record<string, unknown>): OutputMode {
  const raw = optionalString(input, 'output_mode')
  if (raw === undefined) return 'files_with_matches'
  if (raw === 'files_with_matches' || raw === 'count' || raw === 'content')
    return raw
  throw new ToolError('EINVAL', `invalid output_mode: ${raw}`)
}

async function collectFiles(
  root: string,
  filter: ((rel: string) => boolean) | null,
  check: () => void,
): Promise<{ files: string[]; incomplete: boolean }> {
  const out: string[] = []
  let incomplete = false
  let visited = 0
  const stack = [root]
  while (stack.length > 0) {
    check()
    const dir = stack.pop()!
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      incomplete = true
      continue
    }
    entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
    for (const e of entries) {
      if (++visited > MAX_WALK) return { files: out.sort(), incomplete: true }
      if (e.name === 'node_modules' || e.name === '.git') continue
      const full = join(dir, e.name)
      if (e.isDirectory()) stack.push(full)
      else if (e.isFile()) {
        const rel = relative(root, full)
        if (!filter || filter(rel)) out.push(full)
        if (out.length > MAX_FILES) return { files: out.slice(0, MAX_FILES).sort(), incomplete: true }
      }
    }
  }
  return { files: out.sort(), incomplete }
}

export const grepTool: Tool = {
  name: 'grep',
  async run(input, ctx) {
    const page = parseSearchPage(input)
    throwIfAborted(ctx)
    const pattern = requireString(input, 'pattern')
    const pathInput = optionalString(input, 'path')
    const globPattern = optionalString(input, 'glob')
    const caseInsensitive = optionalBoolean(input, 'case_insensitive') ?? false
    const mode = parseMode(input)

    let regex: RegExp
    try {
      regex = new RegExp(pattern, caseInsensitive ? 'i' : '')
    } catch (err) {
      throw new ToolError(
        'EINVAL',
        `invalid regex: ${pattern} (${(err as Error).message})`,
      )
    }

    const rootInput = pathInput ?? ctx.cwd ?? ctx.sandbox.roots[0]!
    let resolvedRoot: string
    try {
      resolvedRoot = await ctx.sandbox.resolve(rootInput, { cwd: ctx.cwd })
    } catch (err) {
      if (err instanceof SandboxError) throw new ToolError(err.code, err.message)
      throw err
    }

    let s
    try {
      s = await stat(resolvedRoot)
    } catch {
      throw new ToolError('ENOENT', `path not found: ${rootInput}`)
    }

    const globFilter = globPattern
      ? picomatch(globPattern, { dot: true })
      : null

    const collected = s.isFile() ? { files: [resolvedRoot], incomplete: false } : await collectFiles(resolvedRoot, globFilter, () => throwIfAborted(ctx))
    const results: string[] = []
    let visited = 0
    let incomplete = collected.incomplete
    const add = (row: string) => {
      if (visited++ >= page.offset) results.push(row)
      return results.length > page.limit
    }
    search: for (const file of collected.files) {
      throwIfAborted(ctx)
      let text: string
      try { text = await readFile(file, 'utf8') } catch { incomplete = true; continue }
      const lines = text.split('\n')
      let fileCount = 0
      for (let i = 0; i < lines.length; i++) {
        if (!regex.test(lines[i]!)) continue
        fileCount++
        if (mode === 'content' && add(`${file}:${i + 1}:${lines[i]}`)) break search
        if (mode === 'files_with_matches') break
      }
      if (fileCount && mode !== 'content' && add(mode === 'count' ? `${file}:${fileCount}` : file)) break
    }
    const more = results.length > page.limit
    if (more) results.pop()
    return [...results, ...searchPageFooter(page, results.length, more, incomplete)].join('\n')
  },
}
