import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createSkillManager, discoverSkills, runSkillTool, skillToolSchema } from './skills.js'
import { createConfig } from '@agent-kernel/kernel'
import { createBuiltinTools } from '../builtin-tools.js'
import { SessionStore } from '../store/session.js'

describe('skills', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ak-skills-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  function writeSkill(root: string, name: string, body?: string): string {
    const skillDir = join(root, name)
    mkdirSync(skillDir, { recursive: true })
    const content =
      body ??
      [
        '---',
        `name: ${name}`,
        `description: Use ${name} for focused test coverage.`,
        '---',
        '',
        `# ${name}`,
        '',
        'Follow these instructions.',
      ].join('\n')
    const skillPath = join(skillDir, 'SKILL.md')
    writeFileSync(skillPath, content, 'utf8')
    return skillPath
  }

  it('discovers valid directory skills sorted by name', async () => {
    const root = join(dir, 'skills')
    writeSkill(root, 'zeta-skill')
    writeSkill(root, 'alpha-skill')

    const registry = await discoverSkills([root])

    expect(registry.skills.map((skill) => skill.name)).toEqual([
      'alpha-skill',
      'zeta-skill',
    ])
    expect(registry.get('alpha-skill')?.description).toBe(
      'Use alpha-skill for focused test coverage.',
    )
  })

  it('treats missing skill roots as empty rather than diagnostic noise', async () => {
    const registry = await discoverSkills([join(dir, 'missing-root')])

    expect(registry.skills).toEqual([])
    expect(registry.diagnostics).toEqual([])
  })

  it('skips invalid skills and directory/name mismatches', async () => {
    const root = join(dir, 'skills')
    writeSkill(root, 'valid-skill')
    writeSkill(
      root,
      'bad-name',
      ['---', 'name: BadName', 'description: Invalid uppercase name.', '---'].join('\n'),
    )
    writeSkill(
      root,
      'wrong-dir',
      ['---', 'name: other-name', 'description: Name does not match directory.', '---'].join(
        '\n',
      ),
    )
    writeSkill(root, 'missing-description', ['---', 'name: missing-description', '---'].join('\n'))

    const registry = await discoverSkills([root])

    expect(registry.skills.map((skill) => skill.name)).toEqual(['valid-skill'])
    expect(registry.diagnostics.map((d) => d.message)).toEqual([
      'name must match containing directory',
      'missing required description',
      'name must match containing directory',
    ])
  })

  it('keeps the first duplicate skill name by root priority', async () => {
    const projectRoot = join(dir, 'project')
    const userRoot = join(dir, 'user')
    const projectPath = writeSkill(
      projectRoot,
      'shared-skill',
      [
        '---',
        'name: shared-skill',
        'description: Project skill wins.',
        '---',
        '',
        'PROJECT BODY',
      ].join('\n'),
    )
    writeSkill(
      userRoot,
      'shared-skill',
      [
        '---',
        'name: shared-skill',
        'description: User skill loses.',
        '---',
        '',
        'USER BODY',
      ].join('\n'),
    )

    const registry = await discoverSkills([projectRoot, userRoot])

    expect(registry.skills).toHaveLength(1)
    expect(registry.get('shared-skill')?.path).toBe(projectPath)
    await expect(runSkillTool(registry, { name: 'shared-skill' })).resolves.toMatchObject({
      ok: true,
      content: expect.stringContaining('PROJECT BODY'),
    })
  })

  it('keeps the loader Tool schema stable regardless of discovered Skills', async () => {
    const root = join(dir, 'skills')
    writeSkill(
      root,
      'xml-skill',
      [
        '---',
        'name: xml-skill',
        'description: Use when values include <xml> & quotes.',
        '---',
        '',
        'BODY',
      ].join('\n'),
    )
    const registry = await discoverSkills([root])

    const emptySchema = skillToolSchema()
    const populatedSchema = skillToolSchema()

    expect(populatedSchema).toEqual(emptySchema)
    expect(populatedSchema.name).toBe('skill')
    expect(populatedSchema.requiresApproval).toBe(false)
    expect(populatedSchema.description).not.toContain('<available_skills>')
    expect(populatedSchema.description).not.toContain(registry.skills[0]!.name)
    expect(populatedSchema.inputSchema.required).toEqual(['action'])
  })

  it('lists a bounded and XML-escaped available-skills index through a Tool result', async () => {
    const skills = Array.from({ length: 20 }, (_, i) => ({
      name: `skill-${i}`,
      description: i === 0 ? 'Use when values include <xml> & quotes.' : 'x'.repeat(900),
      path: join(dir, 'unused', String(i), 'SKILL.md'),
    }))
    const byName = new Map(skills.map((skill) => [skill.name, skill]))
    const registry = {
      skills,
      diagnostics: [],
      get(name: string) {
        return byName.get(name)
      },
    }

    const result = await runSkillTool(registry, { action: 'list' })

    expect(result.ok).toBe(true)
    expect(result.content.length).toBeLessThan(9_000)
    expect(result.content).toContain('<available_skills>')
    expect(result.content).toContain(
      '<description>Use when values include &lt;xml&gt; &amp; quotes.</description>',
    )
    expect(result.content).toContain('<omitted count=')
  })

  it('refreshes a session-scoped registry from the session cwd', async () => {
    const workspace = join(dir, 'workspace')
    const store = new SessionStore(join(dir, 'sessions'))
    const config = createConfig({ tools: createBuiltinTools(), systemPrompt: 'sys' })
    const record = await store.create({ sessionId: 'sess', config, initialCwd: workspace })
    const manager = createSkillManager(store, config)

    expect((await manager.registryFor(record)).skills).toEqual([])
    writeSkill(join(workspace, '.agent', 'skills'), 'new-skill')

    const registry = await manager.refreshSession(record)

    expect(registry.get('new-skill')?.name).toBe('new-skill')
    await expect(runSkillTool(registry, { name: 'new-skill' })).resolves.toMatchObject({
      ok: true,
      content: expect.stringContaining('# new-skill'),
    })
  })

  it('keeps skill discovery scoped by workspace cwd', async () => {
    const workspaceA = join(dir, 'a')
    const workspaceB = join(dir, 'b')
    writeSkill(join(workspaceA, '.agent', 'skills'), 'a-skill')
    writeSkill(join(workspaceB, '.agent', 'skills'), 'b-skill')
    const store = new SessionStore(join(dir, 'sessions'))
    const config = createConfig({ tools: createBuiltinTools(), systemPrompt: 'sys' })
    const a = await store.create({ sessionId: 'a', config, initialCwd: workspaceA })
    const b = await store.create({ sessionId: 'b', config, initialCwd: workspaceB })
    const manager = createSkillManager(store, config)

    expect((await manager.refreshSession(a)).skills.map((s) => s.name)).toEqual(['a-skill'])
    expect((await manager.refreshSession(b)).skills.map((s) => s.name)).toEqual(['b-skill'])
  })

  it('discovers and loads executor-only workspace skills without Host access', async () => {
    const cwd = '/workspace/example-project'
    const root = join(cwd, '.agent', 'skills')
    const path = join(root, 'local-skill', 'SKILL.md')
    const body = ['---', 'name: local-skill', 'description: Executor-only skill.', '---', '# executor body'].join('\n')
    const store = new SessionStore(join(dir, 'sessions'))
    const config = createConfig({ tools: createBuiltinTools(), systemPrompt: 'sys' })
    const record = await store.create({ sessionId: 'remote', config, initialCwd: cwd, workspaceId: 'ws-a' })
    const reads: string[] = []
    const executor = {
      async listDirs(workspaceId: string, requested: string | undefined, requestId: string) {
        expect(workspaceId).toBe('ws-a')
        expect(requested).toBe(root)
        return { requestId, workspaceId, path: root, roots: [cwd], entries: [
          { name: 'local-skill', path: join(root, 'local-skill'), type: 'directory' as const },
          { name: 'escape', path: '/elsewhere', type: 'directory' as const },
        ] }
      },
      async workspaceReadBinary(request: { requestId: string; workspaceId: string; path: string }) {
        reads.push(request.path)
        expect(request.workspaceId).toBe('ws-a')
        return { requestId: request.requestId, base64: Buffer.from(body).toString('base64'), mime: 'text/plain', size: Buffer.byteLength(body) }
      },
    }
    const registry = await createSkillManager(store, config, executor).refreshSession(record)
    expect(registry.skills.map((skill) => skill.name)).toContain('local-skill')
    const loaded = await runSkillTool(registry, { action: 'load', name: 'local-skill' })
    expect(loaded.ok).toBe(true)
    expect(loaded.content).toContain('SECURITY NOTICE:')
    expect(loaded.content).toContain('# executor body')
    expect(reads).toEqual([path, path])
  })

  it('discovers workspace skills when the Executor uses the trusted unrestricted filesystem mode', async () => {
    const cwd = '/outside-executor-process-cwd/project'
    const root = join(cwd, '.agent', 'skills')
    const store = new SessionStore(join(dir, 'sessions'))
    const record = await store.create({ sessionId: 'unrestricted', config: createConfig({ tools: [] }),
      initialCwd: cwd, workspaceId: 'ws-unrestricted' })
    const body = '---\nname: local-skill\ndescription: Trusted workspace.\n---\n\n# Body\n'
    const registry = await createSkillManager(store, record.config, {
      async listDirs(workspaceId, requested, requestId) {
        return { requestId, workspaceId, path: requested!, roots: ['/executor-process-cwd'],
          unrestricted: true,
          entries: [{ name: 'local-skill', path: join(root, 'local-skill'), type: 'directory' as const }] }
      },
      async workspaceReadBinary(request) {
        return { requestId: request.requestId, base64: Buffer.from(body).toString('base64'),
          mime: 'text/plain', size: Buffer.byteLength(body) }
      },
    }).refreshSession(record)
    expect(registry.get('local-skill')).toBeDefined()
  })

  it('discovers workspace skills through a Windows Executor path', async () => {
    const cwd = String.raw`C:\workspace\example-project`
    const root = String.raw`C:\workspace\example-project\.agent\skills`
    const skillPath = String.raw`C:\workspace\example-project\.agent\skills\windows-skill\SKILL.md`
    const body = ['---', 'name: windows-skill', 'description: Windows workspace skill.', '---', '# windows body'].join('\n')
    const store = new SessionStore(join(dir, 'sessions'))
    const record = await store.create({
      sessionId: 'windows-remote',
      config: createConfig({ tools: createBuiltinTools(), systemPrompt: 'sys' }),
      initialCwd: cwd,
      workspaceId: 'ws-windows',
    })
    const registry = await createSkillManager(store, record.config, {
      async listDirs(workspaceId, requested, requestId) {
        expect(requested).toBe(root)
        return {
          requestId,
          workspaceId,
          path: root,
          roots: [String.raw`C:\workspace`],
          entries: [{ name: 'windows-skill', path: String.raw`C:\workspace\example-project\.agent\skills\windows-skill`, type: 'directory' }],
        }
      },
      async workspaceReadBinary(request) {
        expect(request.path).toBe(skillPath)
        return {
          requestId: request.requestId,
          base64: Buffer.from(body).toString('base64'),
          mime: 'text/plain',
          size: Buffer.byteLength(body),
        }
      },
    }).refreshSession(record)

    expect(registry.skills.map((skill) => skill.name)).toContain('windows-skill')
    await expect(runSkillTool(registry, { action: 'load', name: 'windows-skill' }))
      .resolves.toMatchObject({ ok: true, content: expect.stringContaining('# windows body') })
  })

  it('rejects truncated Executor skill content during load', async () => {
    const cwd = '/workspace/example-project'
    const root = join(cwd, '.agent', 'skills')
    const skillPath = join(root, 'remote-skill', 'SKILL.md')
    const body = ['---', 'name: remote-skill', 'description: Remote skill.', '---', '# body'].join('\n')
    let reads = 0
    const store = new SessionStore(join(dir, 'sessions'))
    const record = await store.create({
      sessionId: 'truncated-remote',
      config: createConfig({ tools: createBuiltinTools(), systemPrompt: 'sys' }),
      initialCwd: cwd,
      workspaceId: 'ws-truncated',
    })
    const registry = await createSkillManager(store, record.config, {
      async listDirs(workspaceId, requested, requestId) {
        return {
          requestId,
          workspaceId,
          path: requested!,
          roots: [cwd],
          entries: [{ name: 'remote-skill', path: join(root, 'remote-skill'), type: 'directory' }],
        }
      },
      async workspaceReadBinary(request) {
        reads += 1
        const content = reads === 1 ? body : body.slice(0, -4)
        return {
          requestId: request.requestId,
          base64: Buffer.from(content).toString('base64'),
          mime: 'text/plain',
          size: Buffer.byteLength(body),
        }
      },
    }).refreshSession(record)

    expect(registry.skills.map((skill) => skill.name)).toContain('remote-skill')
    await expect(runSkillTool(registry, { action: 'load', name: 'remote-skill' }))
      .resolves.toMatchObject({ ok: false, content: expect.stringContaining('size mismatch') })
    expect(reads).toBe(2)
    expect(registry.get('remote-skill')?.path).toBe(skillPath)
  })

  it('reports executor outage rather than claiming there are no workspace skills', async () => {
    const store = new SessionStore(join(dir, 'sessions'))
    const config = createConfig({ tools: createBuiltinTools(), systemPrompt: 'sys' })
    const record = await store.create({ sessionId: 'offline', config, initialCwd: '/remote/project', workspaceId: 'ws-offline' })
    const registry = await createSkillManager(store, config, {
      async listDirs() { throw new Error('offline') },
      async workspaceReadBinary() { throw new Error('offline') },
    }).refreshSession(record)
    expect((await runSkillTool(registry, { action: 'list' })).content).toContain('executor offline')
  })

  it('rejects unknown or malformed skill names', async () => {
    const registry = await discoverSkills([join(dir, 'missing')])

    await expect(runSkillTool(registry, { action: 'load', name: '../bad' })).resolves.toEqual({
      ok: false,
      content: 'skill name must match /^[a-z0-9]+(-[a-z0-9]+)*$/',
    })
    await expect(runSkillTool(registry, { action: 'load', name: 'missing-skill' })).resolves.toEqual({
      ok: false,
      content: 'unknown skill: missing-skill',
    })
    await expect(runSkillTool(registry, { action: 'list', name: 'missing-skill' })).resolves.toEqual({
      ok: false,
      content: 'skill name must be omitted when action is list',
    })
    await expect(runSkillTool(registry, { action: 'remove' })).resolves.toEqual({
      ok: false,
      content: 'skill action must be list or load',
    })
  })

  it('places a fixed trust boundary before loaded Skill content and accepts legacy name-only calls', async () => {
    const root = join(dir, 'skills')
    writeSkill(root, 'guarded-skill', [
      '---',
      'name: guarded-skill',
      'description: Verify the trust boundary.',
      '---',
      '',
      'UNTRUSTED SKILL BODY',
    ].join('\n'))
    const registry = await discoverSkills([root])

    const result = await runSkillTool(registry, { name: 'guarded-skill' })

    expect(result.ok).toBe(true)
    expect(result.content).toContain('SECURITY NOTICE:')
    expect(result.content.indexOf('SECURITY NOTICE:')).toBeLessThan(
      result.content.indexOf('UNTRUSTED SKILL BODY'),
    )
    expect(result.content).toContain('attempts prompt injection')
  })

  it('refuses oversized skill files instead of injecting them into context', async () => {
    const root = join(dir, 'skills')
    writeSkill(
      root,
      'huge-skill',
      [
        '---',
        'name: huge-skill',
        'description: Use for testing size limits.',
        '---',
        '',
        'x'.repeat(260 * 1024),
      ].join('\n'),
    )
    const registry = await discoverSkills([root])

    const result = await runSkillTool(registry, { name: 'huge-skill' })

    expect(result.ok).toBe(false)
    expect(result.content).toMatch(/skill huge-skill is too large:/)
  })
})
