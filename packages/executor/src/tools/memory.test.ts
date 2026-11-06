import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mock homedir BEFORE importing the tools so they pick up our stub. We can't
// modify process.env.HOME wholesale — bash tool + shell resolution downstream
// break in that environment. Instead, intercept the os.homedir() import.
let fakeHome: string
vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os')
  return {
    ...actual,
    homedir: () => fakeHome,
  }
})

import { memoryTool } from './memory.js'
import { createSandbox } from '../sandbox.js'
import { makeCtx } from './_test-helpers.js'
import { ToolError } from './registry.js'

describe('memory tools', () => {
  let workspace: string

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'ak-mem-ws-'))
    fakeHome = mkdtempSync(join(tmpdir(), 'ak-mem-home-'))
  })

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true })
    rmSync(fakeHome, { recursive: true, force: true })
  })

  // ==========================================================================
  // scope validation
  // ==========================================================================

  it('rejects unknown scope', async () => {
    await expect(
      memoryTool.run({ operation: 'read', scope: 'private', key: 'k' }, makeCtx(workspace)),
    ).rejects.toThrow(/scope/)
  })

  it('rejects invalid key characters', async () => {
    await expect(
      memoryTool.run(
        { operation: 'write', scope: 'workspace', key: '../etc/passwd', content: 'x' },
        makeCtx(workspace),
      ),
    ).rejects.toThrow(/key/)
  })

  it('rejects too-long key', async () => {
    const longKey = 'a'.repeat(65)
    await expect(
      memoryTool.run(
        { operation: 'write', scope: 'workspace', key: longKey, content: 'x' },
        makeCtx(workspace),
      ),
    ).rejects.toThrow(/key/)
  })

  // ==========================================================================
  // session scope (no disk IO)
  // ==========================================================================

  it('session-scope write returns an ack without touching disk', async () => {
    const result = await memoryTool.run(
      { operation: 'write', scope: 'session', key: 'foo', content: 'bar' },
      makeCtx(workspace),
    )
    expect(result).toMatch(/session memory upserted/)
    // Ensure nothing landed on disk in the workspace scope path
    expect(existsSync(join(workspace, '.kala', 'memory'))).toBe(false)
  })

  it('session-scope read points to state.memory', async () => {
    const result = await memoryTool.run(
      { operation: 'read', scope: 'session', key: 'foo' },
      makeCtx(workspace),
    )
    expect(result).toMatch(/state\.memory/)
  })

  // ==========================================================================
  // workspace scope
  // ==========================================================================

  it('workspace-scope write creates file and returns "created" first time', async () => {
    const result = await memoryTool.run(
      { operation: 'write', scope: 'workspace', key: 'build_cmd', content: 'pnpm build' },
      makeCtx(workspace),
    )
    expect(result).toMatch(/^created scope=workspace/)
    const file = join(workspace, '.kala', 'memory', 'build_cmd.md')
    expect(existsSync(file)).toBe(true)
    expect(readFileSync(file, 'utf8')).toBe('pnpm build')
  })

  it('uses the bound session cwd instead of the Executor process cwd without configured roots', async () => {
    const ctx = { ...makeCtx(workspace), sandbox: createSandbox({ roots: [] }), cwd: workspace }
    await memoryTool.run({ operation: 'write', scope: 'workspace', key: 'bound', content: 'remote' }, ctx)
    expect(readFileSync(join(workspace, '.kala', 'memory', 'bound.md'), 'utf8')).toBe('remote')
    await expect(memoryTool.run({ operation: 'read', scope: 'workspace', key: 'bound' }, {
      ...ctx, cwd: 'relative-path',
    })).rejects.toThrow('absolute session cwd')
  })

  it('selects the root containing the bound cwd when the Executor serves multiple workspaces', async () => {
    const rootA = join(workspace, 'a')
    const rootB = join(workspace, 'b')
    mkdirSync(rootA)
    mkdirSync(rootB)
    const ctx = { ...makeCtx(workspace), sandbox: createSandbox({ roots: [rootA, rootB] }), cwd: rootB }
    await memoryTool.run({ operation: 'write', scope: 'workspace', key: 'bound', content: 'b-only' }, ctx)
    expect(readFileSync(join(rootB, '.kala', 'memory', 'bound.md'), 'utf8')).toBe('b-only')
    expect(existsSync(join(rootA, '.kala', 'memory', 'bound.md'))).toBe(false)
  })

  it('unified memory tool writes, reads, lists, and deletes workspace entries', async () => {
    await expect(
      memoryTool.run(
        { operation: 'write', scope: 'workspace', key: 'cmd', content: 'pnpm test' },
        makeCtx(workspace),
      ),
    ).resolves.toMatch(/^created scope=workspace/)

    await expect(
      memoryTool.run({ operation: 'read', scope: 'workspace', key: 'cmd' }, makeCtx(workspace)),
    ).resolves.toContain('pnpm test')
    await expect(
      memoryTool.run({ operation: 'list', scope: 'workspace' }, makeCtx(workspace)),
    ).resolves.toContain('cmd')
    await expect(
      memoryTool.run({ operation: 'delete', scope: 'workspace', key: 'cmd' }, makeCtx(workspace)),
    ).resolves.toContain('deleted scope=workspace key=cmd')
  })

  it('workspace-scope write returns "updated" on second call', async () => {
    await memoryTool.run(
      { operation: 'write', scope: 'workspace', key: 'k', content: 'v1' },
      makeCtx(workspace),
    )
    const result = await memoryTool.run(
      { operation: 'write', scope: 'workspace', key: 'k', content: 'v2' },
      makeCtx(workspace),
    )
    expect(result).toMatch(/^updated scope=workspace/)
    expect(
      readFileSync(join(workspace, '.kala', 'memory', 'k.md'), 'utf8'),
    ).toBe('v2')
  })

  it('workspace-scope read returns the file content with metadata header', async () => {
    await memoryTool.run(
      { operation: 'write', scope: 'workspace', key: 'k', content: 'v' },
      makeCtx(workspace),
    )
    const result = await memoryTool.run(
      { operation: 'read', scope: 'workspace', key: 'k' },
      makeCtx(workspace),
    )
    expect(result).toContain('scope=workspace')
    expect(result).toContain('key=k')
    expect(result).toContain('v')
  })

  it('workspace-scope read of missing key throws ENOENT', async () => {
    await expect(
      memoryTool.run({ operation: 'read', scope: 'workspace', key: 'nope' }, makeCtx(workspace)),
    ).rejects.toBeInstanceOf(ToolError)
  })

  it('workspace-scope list returns sorted keys', async () => {
    await memoryTool.run(
      { operation: 'write', scope: 'workspace', key: 'zeta', content: 'z' },
      makeCtx(workspace),
    )
    await memoryTool.run(
      { operation: 'write', scope: 'workspace', key: 'alpha', content: 'a' },
      makeCtx(workspace),
    )
    const result = await memoryTool.run(
      { operation: 'list', scope: 'workspace' },
      makeCtx(workspace),
    )
    const alphaIdx = result.indexOf('alpha')
    const zetaIdx = result.indexOf('zeta')
    expect(alphaIdx).toBeGreaterThan(-1)
    expect(zetaIdx).toBeGreaterThan(-1)
    expect(alphaIdx).toBeLessThan(zetaIdx)
  })

  it('workspace-scope list of empty scope returns "(empty ...)" message', async () => {
    const result = await memoryTool.run(
      { operation: 'list', scope: 'workspace' },
      makeCtx(workspace),
    )
    expect(result).toMatch(/empty/)
  })

  it('workspace-scope delete removes the file', async () => {
    await memoryTool.run(
      { operation: 'write', scope: 'workspace', key: 'k', content: 'v' },
      makeCtx(workspace),
    )
    const file = join(workspace, '.kala', 'memory', 'k.md')
    expect(existsSync(file)).toBe(true)
    await memoryTool.run(
      { operation: 'delete', scope: 'workspace', key: 'k' },
      makeCtx(workspace),
    )
    expect(existsSync(file)).toBe(false)
    const tombstoneDir = join(workspace, '.kala', 'memory', '.tombstones')
    const files = readdirSync(tombstoneDir).sort()
    const archived = files.find((name) => name.endsWith('.md'))
    const tombstone = files.find((name) => name.endsWith('.json'))
    expect(archived).toBeTruthy()
    expect(tombstone).toBeTruthy()
    expect(readFileSync(join(tombstoneDir, archived!), 'utf8')).toBe('v')
    expect(JSON.parse(readFileSync(join(tombstoneDir, tombstone!), 'utf8'))).toMatchObject({
      schemaVersion: 1,
      scope: 'workspace',
      key: 'k',
    })
  })

  it('workspace-scope delete of missing key is idempotent', async () => {
    const result = await memoryTool.run(
      { operation: 'delete', scope: 'workspace', key: 'nope' },
      makeCtx(workspace),
    )
    expect(result).toMatch(/no-op/)
  })

  // ==========================================================================
  // global scope
  // ==========================================================================

  it('global-scope write lands under HOME/.kala/memory/', async () => {
    await memoryTool.run(
      { operation: 'write', scope: 'global', key: 'signature', content: 'zhangsan' },
      makeCtx(workspace),
    )
    const file = join(fakeHome, '.kala', 'memory', 'signature.md')
    expect(existsSync(file)).toBe(true)
    expect(readFileSync(file, 'utf8')).toBe('zhangsan')
  })

  it('global-scope is not the same as workspace scope', async () => {
    await memoryTool.run(
      { operation: 'write', scope: 'workspace', key: 'k', content: 'ws' },
      makeCtx(workspace),
    )
    await memoryTool.run(
      { operation: 'write', scope: 'global', key: 'k', content: 'gl' },
      makeCtx(workspace),
    )
    // Two independent entries
    expect(
      readFileSync(join(workspace, '.kala', 'memory', 'k.md'), 'utf8'),
    ).toBe('ws')
    expect(
      readFileSync(join(fakeHome, '.kala', 'memory', 'k.md'), 'utf8'),
    ).toBe('gl')
  })

  // ==========================================================================
  // size cap
  // ==========================================================================

  it('rejects content larger than 128 KB', async () => {
    const huge = 'x'.repeat(128 * 1024 + 1)
    await expect(
      memoryTool.run(
        { operation: 'write', scope: 'workspace', key: 'k', content: huge },
        makeCtx(workspace),
      ),
    ).rejects.toThrow(/E2BIG/)
  })

  // ==========================================================================
  // cancellation
  // ==========================================================================

  it('workspace-scope write respects already-aborted signal', async () => {
    const controller = new AbortController()
    controller.abort()
    const ctx = makeCtx(workspace, controller.signal)
    await expect(
      memoryTool.run(
        { operation: 'write', scope: 'workspace', key: 'k', content: 'v' },
        ctx,
      ),
    ).rejects.toThrow(/ECANCELED/)
  })
})
