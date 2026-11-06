import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { createSandbox } from '../sandbox.js'
import { skillFileTool } from './skill-file.js'

describe('Executor workspace skill file', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it('creates without clobbering and rejects stale updates and deletes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kala-executor-skill-'))
    dirs.push(root)
    const ctx = { cwd: root, sessionId: 'session', callId: 'call', sandbox: createSandbox({ roots: [root] }),
      signal: new AbortController().signal }
    const path = join(root, '.agent', 'skills', 'local-skill', 'SKILL.md')
    const content = '---\nname: local-skill\ndescription: Check\n---\n\nFirst.\n'
    expect(await skillFileTool.run({ action: 'read', name: 'local-skill' }, ctx)).toBe('{"exists":false}')
    await skillFileTool.run({ action: 'create', name: 'local-skill', content }, ctx)
    const read = JSON.parse(await skillFileTool.run({ action: 'read', name: 'local-skill' }, ctx)) as {
      content: string; revision: string }
    expect(read.content).toBe(content)
    await expect(skillFileTool.run({ action: 'create', name: 'local-skill', content: 'clobber' }, ctx))
      .rejects.toThrow('already exists')
    writeFileSync(path, content.replace('First.', 'External.'))
    await expect(skillFileTool.run({ action: 'replace', name: 'local-skill',
      expected_revision: read.revision, content: 'wrong' }, ctx)).rejects.toThrow('changed')
    await expect(skillFileTool.run({ action: 'delete', name: 'local-skill',
      expected_revision: read.revision }, ctx)).rejects.toThrow('changed')
    expect(readFileSync(path, 'utf8')).toContain('External.')
    const latest = JSON.parse(await skillFileTool.run({ action: 'read', name: 'local-skill' }, ctx)) as {
      revision: string }
    await skillFileTool.run({ action: 'replace', name: 'local-skill',
      expected_revision: latest.revision, content }, ctx)
    await skillFileTool.run({ action: 'delete', name: 'local-skill',
      expected_revision: read.revision }, ctx)
    expect(await skillFileTool.run({ action: 'read', name: 'local-skill' }, ctx)).toBe('{"exists":false}')
  })

  it('rejects path traversal and paths outside a configured sandbox', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kala-executor-skill-root-'))
    const outside = mkdtempSync(join(tmpdir(), 'kala-executor-skill-outside-'))
    dirs.push(root, outside)
    const ctx = { cwd: root, sessionId: 'session', callId: 'call', sandbox: createSandbox({ roots: [root] }),
      signal: new AbortController().signal }
    await expect(skillFileTool.run({ action: 'create', name: '../outside', content: 'no' }, ctx))
      .rejects.toThrow('invalid workspace skill')
    mkdirSync(join(root, '.agent'), { recursive: true })
    symlinkSync(outside, join(root, '.agent', 'skills'))
    await expect(skillFileTool.run({ action: 'create', name: 'blocked', content: 'no' }, ctx))
      .rejects.toThrow('outside sandbox')
  })

  it('serializes competing writes to the same skill and does not report both creates successful', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kala-executor-skill-race-'))
    dirs.push(root)
    const ctx = { cwd: root, sessionId: 'session', callId: 'call', sandbox: createSandbox({ roots: [root] }),
      signal: new AbortController().signal }
    const outcomes = await Promise.allSettled([
      skillFileTool.run({ action: 'create', name: 'one-skill', content: 'first' }, ctx),
      skillFileTool.run({ action: 'create', name: 'one-skill', content: 'second' }, ctx),
    ])
    expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(['fulfilled', 'rejected'])
    expect(readFileSync(join(root, '.agent', 'skills', 'one-skill', 'SKILL.md'), 'utf8'))
      .toMatch(/^(first|second)$/)
  })

  it('refuses oversized existing skills before reading their content into a tool result', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kala-executor-skill-large-'))
    dirs.push(root)
    const skillDir = join(root, '.agent', 'skills', 'large-skill')
    mkdirSync(skillDir, { recursive: true })
    const path = join(skillDir, 'SKILL.md')
    writeFileSync(path, Buffer.alloc(256 * 1024 + 1, 'a'))
    const ctx = { cwd: root, sessionId: 'session', callId: 'call', sandbox: createSandbox({ roots: [root] }),
      signal: new AbortController().signal }
    await expect(skillFileTool.run({ action: 'read', name: 'large-skill' }, ctx))
      .rejects.toThrow('size limit')
    await expect(skillFileTool.run({ action: 'delete', name: 'large-skill',
      expected_revision: 'a'.repeat(64) }, ctx)).rejects.toThrow('size limit')
    expect(readFileSync(path).length).toBe(256 * 1024 + 1)
  })
})
