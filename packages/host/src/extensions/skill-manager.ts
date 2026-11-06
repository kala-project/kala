import { lstatSync } from 'node:fs'
import { mkdir, readFile, rename, rm, rmdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, parse, resolve } from 'node:path'

import type { CallToolEffect, ToolSchema } from '@agent-kernel/kernel'
import { executionRequestDigest } from '@agent-kernel/executor'
import { ulid } from 'ulid'

import type { HostLoopDeps } from '../loop-types.js'
import { isSkillManager } from './skills.js'

export const SKILL_MANAGER_TOOL_NAME = 'skill_manager'

const SKILL_NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/
const MAX_SKILL_NAME_LENGTH = 64
const MAX_DESCRIPTION_LENGTH = 1024
const MAX_SKILL_BYTES = 256 * 1024

export type SkillScope = 'workspace' | 'global'
type SkillManagerResult = { ok: boolean; content: string; indeterminate?: boolean }

export type SkillValidationResult =
  | {
      ok: true
      name: string
      description: string
      body: string
      normalizedContent: string
    }
  | {
      ok: false
      reason: string
    }

const SECURITY_BLOCKLIST_PATTERNS: readonly { pattern: RegExp; reason: string }[] = [
  {
    pattern: /\b(?:ignore|disregard|forget)\s+(?:(?:all|the|your)\s+)?(?:previous|prior|above|system|developer)\s+(?:instructions|prompts?|messages?)\b/i,
    reason: 'skill content contains prompt-injection instruction override pattern',
  },
  {
    pattern: /\byou\s+are\s+now\s+in\s+developer\s+mode\b|\bsystem\s+override\b/i,
    reason: 'skill content contains privilege-escalation / role-override pattern',
  },
  {
    pattern: /\b(?:curl|wget|nc|netcat)\b[^\n]*(?:\$[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)|\.env\b|id_rsa|SSH_AUTH_SOCK)/i,
    reason: 'skill content contains suspected secret/credential exfiltration command',
  },
  {
    pattern: /\brm\s+-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*\s+\/(?:\s|$|`|'|"|\*)/i,
    reason: 'skill content contains destructive root filesystem deletion command',
  },
  {
    pattern: /\b(?:mkfs(?:\.[a-z0-9]+)?|:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;?\s*:)\b/i,
    reason: 'skill content contains destructive host command',
  },
  {
    pattern: /\b(?:curl|wget|nc|netcat|fetch|Invoke-WebRequest)\b[^\n]*(?:\$\{[^}]*\}|(?:AWS|OPENAI|ANTHROPIC|GITHUB|GH|SSH)_[A-Z_]*(?:KEY|TOKEN|SECRET|SOCK)|\.env\b|id_rsa)/i,
    reason: 'skill content contains suspected secret/credential exfiltration command',
  },
  {
    pattern: /\b(?:curl|wget)\b[^\n]*\|\s*(?:sh|bash|zsh|powershell|pwsh)\b/i,
    reason: 'skill content contains remote code execution pipeline',
  },
  {
    pattern: /\b(?:printenv|env|cat)\b[^\n]*\|\s*(?:curl|wget|nc|netcat)\b/i,
    reason: 'skill content contains suspected environment exfiltration pipeline',
  },
]

export function skillManagerToolSchema(): ToolSchema {
  return {
    name: SKILL_MANAGER_TOOL_NAME,
    description:
      'Manage procedural skills (SKILL.md) in the bound Executor workspace or trusted Host-global root. Shared-owner workspace mutations require a durable effect fence.',
    inputSchema: {
      type: 'object',
      required: ['action', 'name'],
      properties: {
        action: {
          type: 'string',
          enum: ['create', 'patch', 'delete'],
          description:
            'create writes a new SKILL.md (or replaces when overwrite=true); patch applies an exact string replacement to self-heal an existing SKILL.md; delete removes a skill.',
        },
        name: {
          type: 'string',
          pattern: SKILL_NAME_PATTERN.source,
          maxLength: MAX_SKILL_NAME_LENGTH,
          description: 'Kebab-case skill identifier matching /^[a-z0-9]+(-[a-z0-9]+)*$/.',
        },
        scope: {
          type: 'string',
          enum: ['workspace', 'global'],
          default: 'workspace',
          description: 'Target skill root: workspace (.agent/skills) or global (~/.agent/skills).',
        },
        description: {
          type: 'string',
          maxLength: MAX_DESCRIPTION_LENGTH,
          description:
            'Concise 1-line trigger description (1-1024 chars) used by skill action=list. Required for create unless content already includes valid frontmatter.',
        },
        content: {
          type: 'string',
          description:
            'For action=create: either the full SKILL.md (with --- frontmatter) or the Markdown body.',
        },
        old_string: {
          type: 'string',
          description: 'For action=patch: exact text to replace in the existing SKILL.md.',
        },
        new_string: {
          type: 'string',
          description: 'For action=patch: replacement text.',
        },
        replace_all: {
          type: 'boolean',
          description: 'For action=patch: replace every occurrence of old_string when true.',
        },
        overwrite: {
          type: 'boolean',
          description: 'For action=create: allow overwriting an existing SKILL.md when true.',
        },
      },
    },
    requiresApproval: false,
  }
}

export function validateSkillContent(
  expectedName: string,
  rawContent: string,
  fallbackDescription?: string,
): SkillValidationResult {
  if (
    typeof expectedName !== 'string' ||
    expectedName.length === 0 ||
    expectedName.length > MAX_SKILL_NAME_LENGTH ||
    !SKILL_NAME_PATTERN.test(expectedName)
  ) {
    return {
      ok: false,
      reason: `skill name must match /^[a-z0-9]+(-[a-z0-9]+)*$/ and be at most ${MAX_SKILL_NAME_LENGTH} characters`,
    }
  }

  const trimmed = rawContent.trim()
  if (trimmed.length === 0) {
    return { ok: false, reason: 'skill content must not be empty' }
  }

  let normalizedContent = rawContent
  const parsedFrontmatter = parseFrontmatterAndBody(rawContent)
  if (!parsedFrontmatter) {
    const desc = fallbackDescription?.trim()
    if (!desc) {
      return {
        ok: false,
        reason: 'missing YAML frontmatter (---) and no description parameter provided',
      }
    }
    normalizedContent = renderSkillMarkdown(expectedName, desc, rawContent)
  }

  const bytes = Buffer.byteLength(normalizedContent, 'utf8')
  if (bytes > MAX_SKILL_BYTES) {
    return {
      ok: false,
      reason: `skill content exceeds maximum size (${bytes} > ${MAX_SKILL_BYTES} bytes)`,
    }
  }

  const verified = parseFrontmatterAndBody(normalizedContent)
  if (!verified) {
    return { ok: false, reason: 'missing or malformed YAML frontmatter' }
  }

  const fmName = verified.frontmatter.get('name')
  const fmDescription = verified.frontmatter.get('description')?.trim()
  if (!fmName) {
    return { ok: false, reason: 'frontmatter is missing required "name" field' }
  }
  if (fmName !== expectedName) {
    return {
      ok: false,
      reason: `frontmatter name "${fmName}" must match skill name "${expectedName}"`,
    }
  }
  if (!fmDescription || fmDescription.length === 0 || fmDescription.length > MAX_DESCRIPTION_LENGTH) {
    return {
      ok: false,
      reason: `frontmatter description must be 1-${MAX_DESCRIPTION_LENGTH} characters`,
    }
  }
  if (verified.body.trim().length === 0) {
    return { ok: false, reason: 'skill markdown body must not be empty' }
  }

  for (const rule of SECURITY_BLOCKLIST_PATTERNS) {
    if (rule.pattern.test(normalizedContent)) {
      return { ok: false, reason: rule.reason }
    }
  }

  return {
    ok: true,
    name: expectedName,
    description: fmDescription,
    body: verified.body,
    normalizedContent: normalizedContent.endsWith('\n') ? normalizedContent : `${normalizedContent}\n`,
  }
}

export async function runSkillManagerTool(
  deps: HostLoopDeps,
  sessionId: string,
  effect: CallToolEffect,
  options?: { globalRootOverride?: string },
): Promise<SkillManagerResult> {
  const record = deps.store.get(sessionId)
  if (!record) return { ok: false, content: `unknown session: ${sessionId}` }

  const input = effect.input
  const action = input.action
  const name = typeof input.name === 'string' ? input.name.trim() : ''
  if (input.scope !== undefined && input.scope !== 'workspace' && input.scope !== 'global') {
    return { ok: false, content: 'invalid skill scope' }
  }
  const scope: SkillScope = input.scope === 'global' ? 'global' : 'workspace'
  if (scope === 'global' && (record.workspaceId || record.organizationId || deps.assertSessionEffectOwner)) {
    return { ok: false, content: 'global skill writes are unavailable for workspace-bound or shared sessions' }
  }
  if (action !== 'create' && action !== 'patch' && action !== 'delete') {
    return { ok: false, content: 'skill_manager action must be create, patch, or delete' }
  }
  if (!name || name.length > MAX_SKILL_NAME_LENGTH || !SKILL_NAME_PATTERN.test(name)) {
    return {
      ok: false,
      content: `skill name must match /^[a-z0-9]+(-[a-z0-9]+)*$/ (max ${MAX_SKILL_NAME_LENGTH} chars)`,
    }
  }
  if (scope === 'workspace') {
    return runWorkspaceSkillManagerTool(deps, record, sessionId, effect, name, action)
  }

  const rootDir = resolveSkillRoot(record.state.cwd ?? process.cwd(), scope, options?.globalRootOverride)
  const skillDir = resolve(rootDir, name)
  if (dirname(skillDir) !== rootDir) {
    return { ok: false, content: 'skill path escaped target skill root' }
  }
  const skillPath = join(skillDir, 'SKILL.md')
  const owner = deps.captureSessionEffectOwner?.(sessionId)
  const assertOwner = async () => {
    if (owner && !owner()) throw new Error('session ownership changed during skill mutation')
    await deps.assertSessionEffectOwner?.(sessionId)
    if (owner && !owner()) throw new Error('session ownership changed during skill mutation')
  }
  try {
    await assertOwner()
    assertNoSymlink(skillPath)

  if (action === 'create') {
    const rawContent = typeof input.content === 'string' ? input.content : ''
    const description = typeof input.description === 'string' ? input.description : undefined
    const overwrite = input.overwrite === true

    const validation = validateSkillContent(name, rawContent, description)
    if (!validation.ok) {
      return { ok: false, content: `skill validation failed: ${validation.reason}` }
    }

    if (pathExists(skillPath) && !overwrite) {
      return {
        ok: false,
        content: `skill "${name}" already exists at ${skillPath}; use action="patch" to update it or set overwrite=true`,
      }
    }

    await assertOwner()
    await writeSkillFileAtomically(skillPath, validation.normalizedContent, overwrite)
    await refreshSkillsIfConfigured(deps, record)
    return {
      ok: true,
      content: JSON.stringify({
        status: 'created',
        name,
        scope,
        path: skillPath,
        description: validation.description,
      }),
    }
  }

  if (action === 'patch') {
    const oldString = typeof input.old_string === 'string' ? input.old_string : ''
    const newString = typeof input.new_string === 'string' ? input.new_string : undefined
    const replaceAll = input.replace_all === true

    if (oldString.length === 0 || newString === undefined) {
      return {
        ok: false,
        content: 'skill_manager patch requires non-empty old_string and a string new_string',
      }
    }
    if (!pathExists(skillPath)) {
      return { ok: false, content: `skill "${name}" does not exist at ${skillPath}` }
    }

    const current = await readFile(skillPath, 'utf8')
    const occurrences = countOccurrences(current, oldString)
    if (occurrences === 0) {
      return { ok: false, content: `old_string not found in skill "${name}"` }
    }
    if (occurrences > 1 && !replaceAll) {
      return {
        ok: false,
        content: `old_string matched ${occurrences} locations in skill "${name}"; provide more context or set replace_all=true`,
      }
    }

    const patched = replaceAll
      ? current.split(oldString).join(newString)
      : current.replace(oldString, () => newString)

    const validation = validateSkillContent(name, patched)
    if (!validation.ok) {
      return { ok: false, content: `patched skill failed validation: ${validation.reason}` }
    }

    await assertOwner()
    assertNoSymlink(skillPath)
    await writeSkillFileAtomically(skillPath, validation.normalizedContent, true)
    await refreshSkillsIfConfigured(deps, record)
    return {
      ok: true,
      content: JSON.stringify({
        status: 'patched',
        name,
        scope,
        path: skillPath,
        replacements: replaceAll ? occurrences : 1,
      }),
    }
  }

  // action === 'delete'
  if (!pathExists(skillPath)) {
    return { ok: false, content: `skill "${name}" does not exist at ${skillPath}` }
  }
  await assertOwner()
  assertNoSymlink(skillPath)
  await rm(skillPath)
  await rmdir(skillDir).catch((err: NodeJS.ErrnoException) => {
    if (err.code !== 'ENOTEMPTY' && err.code !== 'EEXIST') throw err
  })
  await refreshSkillsIfConfigured(deps, record)
  return {
    ok: true,
    content: JSON.stringify({
      status: 'deleted',
      name,
      scope,
      path: skillPath,
    }),
  }
  } catch (error) {
    return { ok: false, content: error instanceof Error ? error.message : String(error) }
  }
}

async function runWorkspaceSkillManagerTool(
  deps: HostLoopDeps,
  record: NonNullable<ReturnType<HostLoopDeps['store']['get']>>,
  sessionId: string,
  effect: CallToolEffect,
  name: string,
  action: 'create' | 'patch' | 'delete',
): Promise<SkillManagerResult> {
  if (!record.state.cwd) return { ok: false, content: 'workspace skill requires a bound Executor cwd' }
  const fenced = deps.requireSkillEffectBarrier || !!deps.assertSessionEffectOwner || !!deps.captureSessionEffectOwner
  if (fenced && (!deps.assertSessionEffectOwner || !deps.registerSkillEffect ||
    !deps.releaseNeverDispatchedSkillEffect || !deps.tools.queryExecutionReceipt || !record.workspaceId)) {
    return { ok: false, content: 'workspace skill mutations require a durable shared-owner effect fence' }
  }
  const input = effect.input
  const path = `.agent/skills/${name}/SKILL.md`
  let indeterminate = false
  const call = async (step: 'read' | 'mutate', operation: Record<string, unknown>) => {
    const owner = step === 'mutate' && fenced ? await deps.assertSessionEffectOwner!(sessionId) : undefined
    if (step === 'mutate' && fenced && !owner?.ownerGeneration) {
      throw new Error('shared-owner skill mutation has no verified owner generation')
    }
    const callId = step === 'mutate' && fenced ? `skill-file-${ulid()}` : `${effect.callId}:skill-${step}`
    const mutation = {
      kind: 'call_tool',
      callId,
      name: 'skill_file',
      cwd: record.state.cwd,
      input: { name, ...operation, ...(owner?.ownerGeneration ? { ownerGeneration: owner.ownerGeneration } : {}) },
    } as const
    let complete: (() => Promise<void>) | undefined
    if (owner?.ownerGeneration) {
      try {
        complete = await deps.registerSkillEffect!(sessionId, owner.ownerGeneration, callId, record.workspaceId!)
      } catch (error) {
        indeterminate = true
        throw new Error(`UNKNOWN skill effect ${callId}: PostgreSQL registration unconfirmed; no Executor mutation dispatched: ${String(error)}`)
      }
    }
    let result: Awaited<ReturnType<HostLoopDeps['tools']['callTool']>>
    try {
      result = await deps.tools.callTool(sessionId, mutation)
    } catch (error) {
      if (complete) {
        try {
          await deps.releaseNeverDispatchedSkillEffect!(sessionId, owner!.ownerGeneration, callId, record.workspaceId!)
          throw error
        } catch (releaseError) {
          if (releaseError !== error) {
            indeterminate = true
            throw new Error(`UNKNOWN skill effect ${callId}: ${String(error)}; dispatch may have started`)
          }
        }
      }
      throw error
    }
    if (complete) {
      if (result.failure?.code === 'skill_pre_dispatch_rejected') {
        try {
          await deps.releaseNeverDispatchedSkillEffect!(sessionId, owner!.ownerGeneration, callId, record.workspaceId!)
        } catch {
          indeterminate = true
          throw new Error(`UNKNOWN skill effect ${callId}: pre-dispatch proof unavailable`)
        }
      } else {
        const requestDigest = executionRequestDigest({
          sessionId, callId, name: mutation.name, input: mutation.input,
          cwd: mutation.cwd, origin: 'host',
        })
        const receipt = await deps.tools.queryExecutionReceipt!({
          sessionId, callId, ownerGeneration: owner!.ownerGeneration, requestDigest,
        }).catch(() => ({ status: 'unavailable' as const }))
        if (receipt.status !== 'completed' || receipt.result.callId !== callId
          || receipt.result.ok !== result.ok || receipt.result.content !== result.content
          || JSON.stringify(receipt.result.failure) !== JSON.stringify(result.failure)) {
          indeterminate = true
          throw new Error(`UNKNOWN skill effect ${callId}: no matching durable final Executor receipt`)
        }
        try {
          await complete()
        } catch (error) {
          indeterminate = true
          throw new Error(`UNKNOWN skill effect ${callId}: final receipt verified but PostgreSQL release unconfirmed: ${String(error)}`)
        }
      }
    }
    if (!result.ok) {
      indeterminate = result.failure?.outcome === 'indeterminate'
      throw new Error(result.content)
    }
    return result.content
  }
  try {
    let content: string | undefined
    let revision: string | undefined
    if (action !== 'create' || input.overwrite === true) {
      const current: unknown = JSON.parse(await call('read', { action: 'read' }))
      if (!current || typeof current !== 'object' || !('exists' in current) ||
        typeof current.exists !== 'boolean') throw new Error('invalid Executor skill read receipt')
      if (current.exists) {
        if (!('content' in current) || typeof current.content !== 'string' ||
          !('revision' in current) || typeof current.revision !== 'string' ||
          !/^[a-f0-9]{64}$/.test(current.revision)) throw new Error('invalid Executor skill read receipt')
        content = current.content
        revision = current.revision
      }
    }

    if (action === 'create') {
      const validation = validateSkillContent(name,
        typeof input.content === 'string' ? input.content : '',
        typeof input.description === 'string' ? input.description : undefined)
      if (!validation.ok) return { ok: false, content: `skill validation failed: ${validation.reason}` }
      if (revision && input.overwrite !== true) return { ok: false, content: `skill "${name}" already exists at ${path}` }
      await call('mutate', { action: 'create', content: validation.normalizedContent,
        ...(revision ? { expected_revision: revision } : {}) })
      await refreshSkillsIfConfigured(deps, record)
      return { ok: true, content: JSON.stringify({ status: 'created', name, scope: 'workspace',
        path, description: validation.description }) }
    }

    if (!revision || content === undefined) return { ok: false, content: `skill "${name}" does not exist at ${path}` }
    if (action === 'patch') {
      const oldString = typeof input.old_string === 'string' ? input.old_string : ''
      const newString = typeof input.new_string === 'string' ? input.new_string : undefined
      if (!oldString || newString === undefined) {
        return { ok: false, content: 'skill_manager patch requires non-empty old_string and a string new_string' }
      }
      const occurrences = countOccurrences(content, oldString)
      if (!occurrences) return { ok: false, content: `old_string not found in skill "${name}"` }
      if (occurrences > 1 && input.replace_all !== true) {
        return { ok: false, content: `old_string matched ${occurrences} locations in skill "${name}"; provide more context or set replace_all=true` }
      }
      const patched = input.replace_all === true
        ? content.split(oldString).join(newString)
        : content.replace(oldString, () => newString)
      const validation = validateSkillContent(name, patched)
      if (!validation.ok) return { ok: false, content: `patched skill failed validation: ${validation.reason}` }
      await call('mutate', { action: 'replace', expected_revision: revision, content: validation.normalizedContent })
      await refreshSkillsIfConfigured(deps, record)
      return { ok: true, content: JSON.stringify({ status: 'patched', name, scope: 'workspace',
        path, replacements: input.replace_all === true ? occurrences : 1 }) }
    }
    await call('mutate', { action: 'delete', expected_revision: revision })
    await refreshSkillsIfConfigured(deps, record)
    return { ok: true, content: JSON.stringify({ status: 'deleted', name, scope: 'workspace', path }) }
  } catch (error) {
    return { ok: false, content: error instanceof Error ? error.message : String(error),
      ...(indeterminate ? { indeterminate: true } : {}) }
  }
}

function resolveSkillRoot(cwd: string, scope: SkillScope, globalRootOverride?: string): string {
  if (scope === 'global') {
    return resolve(globalRootOverride ?? join(homedir(), '.agent', 'skills'))
  }
  return resolve(cwd, '.agent', 'skills')
}

function pathExists(path: string): boolean {
  try { lstatSync(path); return true } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

function assertNoSymlink(path: string): void {
  let current = parse(resolve(path)).root
  for (const part of resolve(path).slice(current.length).split(/[\\/]/).filter(Boolean)) {
    current = join(current, part)
    try {
      if (lstatSync(current).isSymbolicLink()) throw new Error(`symlink in skill path: ${current}`)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
}

async function writeSkillFileAtomically(skillPath: string, content: string, overwrite: boolean): Promise<void> {
  assertNoSymlink(skillPath)
  const dir = dirname(skillPath)
  await mkdir(dir, { recursive: true })
  assertNoSymlink(skillPath)
  if (!overwrite) {
    await writeFile(skillPath, content, { encoding: 'utf8', flag: 'wx' })
    return
  }
  const tmpPath = `${skillPath}.tmp.${process.pid}.${Date.now()}`
  try {
    await writeFile(tmpPath, content, { encoding: 'utf8', flag: 'wx' })
    assertNoSymlink(skillPath)
    await rename(tmpPath, skillPath)
  } catch (error) {
    await rm(tmpPath, { force: true })
    throw error
  }
}

async function refreshSkillsIfConfigured(
  deps: HostLoopDeps,
  record: NonNullable<ReturnType<HostLoopDeps['store']['get']>>,
): Promise<void> {
  if (isSkillManager(deps.skills)) {
    await deps.skills.refreshSession(record)
  }
}

function countOccurrences(text: string, needle: string): number {
  if (needle.length === 0) return 0
  let count = 0
  let pos = 0
  while (true) {
    const idx = text.indexOf(needle, pos)
    if (idx === -1) break
    count += 1
    pos = idx + needle.length
  }
  return count
}

function renderSkillMarkdown(name: string, description: string, body: string): string {
  const safeDescription = /[:#\n"'\\]/.test(description)
    ? `"${description.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
    : description
  return [
    '---',
    `name: ${name}`,
    `description: ${safeDescription}`,
    '---',
    '',
    body.trim(),
    '',
  ].join('\n')
}

function parseFrontmatterAndBody(
  content: string,
): { frontmatter: Map<string, string>; body: string } | null {
  const lines = content.split(/\r?\n/)
  if (lines[0]?.trim() !== '---') return null
  const values = new Map<string, string>()
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]
    if (line?.trim() === '---') {
      const body = lines.slice(i + 1).join('\n')
      return { frontmatter: values, body }
    }
    if (!line || line.trim().startsWith('#')) continue
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
    if (!match) continue
    const key = match[1]!
    const raw = match[2]!.trim()
    values.set(key, unquote(raw))
  }
  return null
}

function unquote(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1)
  }
  return value
}
