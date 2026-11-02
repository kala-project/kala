import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { createHookRunner } from '../extensions/hooks.js'
import { parseHookConfigToml } from '../runtime-config.js'

export function loadRuntimeHooks(options: { unitRoot: string; product: string; configPath?: string }) {
  if (options.configPath && options.product !== 'dedicated') throw new Error('Shared hook configuration is allowed only for Dedicated; provision hooks in each Runtime Unit')
  const configPath = options.configPath ?? join(options.unitRoot, 'config.toml')
  let contents: string
  try { contents = readFileSync(configPath, 'utf8') }
  catch (error) {
    if (!options.configPath && (error as NodeJS.ErrnoException).code === 'ENOENT') return { configPath, hooks: [], hookRunner: undefined }
    throw error
  }
  const hooks = parseHookConfigToml(contents)
  if ((contents.match(/^\s*\[\[hooks\]\]\s*(?:#.*)?$/gmu)?.length ?? 0) !== hooks.length) throw new Error(`Invalid Runtime hook configuration: ${configPath}`)
  return { configPath, hooks, hookRunner: hooks.length ? createHookRunner() : undefined }
}
