import { readdir, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'
import picomatch from 'picomatch'

import { SandboxError } from '../sandbox.js'
import type { Tool } from './registry.js'
import { parseSearchPage, searchPageFooter } from './search-page.js'
import { ToolError, throwIfAborted } from './registry.js'
import { optionalString, requireString } from './schema.js'

const MAX_WALK = 100_000

async function walk(root: string, onFile: (abs: string) => void, check: () => void): Promise<boolean> {
  const stack: string[] = [root]
  let seen = 0
  let incomplete = false
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
      if (++seen > MAX_WALK) return true
      if (e.name === 'node_modules' || e.name === '.git') continue
      const full = join(dir, e.name)
      if (e.isDirectory()) {
        stack.push(full)
      } else if (e.isFile()) {
        onFile(full)
      }
    }
  }
  return incomplete
}

export const globTool: Tool = {
  name: 'glob',
  async run(input, ctx) {
    const page = parseSearchPage(input)
    throwIfAborted(ctx)
    const pattern = requireString(input, 'pattern')
    const cwdInput = optionalString(input, 'cwd')
    const pathInput = optionalString(input, 'path')
    if (pathInput !== undefined && cwdInput !== undefined && pathInput !== cwdInput) {
      throw new ToolError('EINVAL', 'path and legacy cwd must not disagree')
    }
    const root = pathInput ?? cwdInput ?? ctx.cwd ?? ctx.sandbox.roots[0]!

    let resolvedRoot: string
    try {
      resolvedRoot = await ctx.sandbox.resolve(root, { cwd: ctx.cwd })
    } catch (err) {
      if (err instanceof SandboxError) throw new ToolError(err.code, err.message)
      throw err
    }

    let matcher: (p: string) => boolean
    try {
      matcher = picomatch(pattern, { dot: true })
    } catch (err) {
      throw new ToolError(
        'EINVAL',
        `invalid glob pattern: ${pattern} (${(err as Error).message})`,
      )
    }

    const matches: Array<{ path: string; mtimeMs: number }> = []
    let incomplete = await walk(resolvedRoot, (abs) => {
      const rel = relative(resolvedRoot, abs)
      if (matcher(rel)) matches.push({ path: abs, mtimeMs: 0 })
    }, () => throwIfAborted(ctx))

    for (let start = 0; start < matches.length; start += 64) {
      throwIfAborted(ctx)
      await Promise.all(
        matches.slice(start, start + 64).map(async (m) => {
          try {
            const s = await stat(m.path)
            m.mtimeMs = s.mtimeMs
          } catch {
            m.mtimeMs = 0
            incomplete = true
          }
        }),
      )
    }
    matches.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))

    const selected = matches.slice(page.offset, page.offset + page.limit)
    const more = matches.length > page.offset + selected.length
    return [...selected.map((m) => m.path), ...searchPageFooter(page, selected.length, more, incomplete)].join('\n')
  },
}
