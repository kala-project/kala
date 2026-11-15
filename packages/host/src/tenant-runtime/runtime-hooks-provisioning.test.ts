import { createHash } from 'node:crypto'
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadRuntimeHooks } from './runtime-hooks.js'
import { provisionRuntimeHooks } from './runtime-hooks-provisioning.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true }) })
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'kala-hook-provisioning-'))
  roots.push(root)
  const configFile = join(root, 'authorized.toml')
  const manifestPath = join(root, 'manifest.json')
  const unitRoot = join(root, 'disposable-unit')
  const command = `"${process.execPath}" -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>process.stdout.write(d))"`
  const contents = ['session_start', 'pre_tool_use', 'post_tool_use', 'session_end'].map(event =>
    `[[hooks]]\nevent = ${JSON.stringify(event)}\ncommand = ${JSON.stringify(command)}\n`).join('\n')
  writeFileSync(configFile, contents, { mode: 0o600 })
  const manifest = { schemaVersion: 1, revision: '7', units: [{
    unitId: 'unit-a', organizationId: 'org-a', configFile,
    contentSha256: createHash('sha256').update(contents).digest('hex'),
  }] }
  writeFileSync(manifestPath, JSON.stringify(manifest), { mode: 0o600 })
  const provision = (organizationId = 'org-a') => provisionRuntimeHooks({ unitRoot, unitId: 'unit-a', organizationId, manifestPath })
  return { root, configFile, manifestPath, unitRoot, manifest, provision, contents }
}

describe('durable protected per-Unit Hook reconstruction', () => {
  it('reconstructs the authorized config after removing the disposable Unit and executes all native Hook events', async () => {
    const f = fixture()
    expect(f.provision()).toEqual({ revision: '7' })
    rmSync(f.unitRoot, { recursive: true })
    expect(f.provision()).toEqual({ revision: '7' })
    expect(readFileSync(join(f.unitRoot, 'config.toml'), 'utf8')).toBe(f.contents)
    const loaded = loadRuntimeHooks({ unitRoot: f.unitRoot, product: 'private-cloud' })
    expect(loaded.loadedAt).toMatch(/^\d{4}-\d\d-\d\dT/u)
    for (const hook of loaded.hooks) {
      const payload = { event: hook.event, sessionId: 'fictional-session', toolName: 'read',
        toolResult: { ok: true, content: 'fictional result' } }
      const outcome = await loaded.hookRunner!.run(hook, payload)
      expect(outcome.ok).toBe(true)
      expect(JSON.parse(outcome.stdout)).toEqual(payload)
    }
    const unrelated = join(f.root, 'another-unit')
    provisionRuntimeHooks({ unitRoot: unrelated, unitId: 'unit-b', organizationId: 'org-b', manifestPath: f.manifestPath })
    expect(loadRuntimeHooks({ unitRoot: unrelated, product: 'private-cloud' }).hooks).toEqual([])
  })

  it('rejects organization mismatch, undeclared manifest fields and altered source without replacing an installed config', () => {
    const f = fixture()
    f.provision()
    expect(() => f.provision('another-org')).toThrow('runtime_hooks_organization_mismatch')
    writeFileSync(f.configFile, '[[hooks]]\nevent = "session_start"\ncommand = "exit 7"\n')
    expect(() => f.provision()).toThrow('runtime_hooks_source_changed')
    expect(readFileSync(join(f.unitRoot, 'config.toml'), 'utf8')).toBe(f.contents)
    writeFileSync(f.manifestPath, JSON.stringify({ ...f.manifest, unreviewed: true }))
    expect(() => f.provision()).toThrow('invalid_runtime_hooks_manifest')
    writeFileSync(f.manifestPath, JSON.stringify({ ...f.manifest, revision: '8', units: [] }))
    f.provision()
    expect(loadRuntimeHooks({ unitRoot: f.unitRoot, product: 'private-cloud' }).hooks).toEqual([])
  })

  it.skipIf(process.platform === 'win32')('rejects public-readable and symlinked protected sources', () => {
    const f = fixture()
    chmodSync(f.manifestPath, 0o644)
    expect(() => f.provision()).toThrow('runtime_hooks_source_must_be_owner_only')
    chmodSync(f.manifestPath, 0o600)
    const link = join(f.root, 'link.toml')
    symlinkSync(f.configFile, link)
    writeFileSync(f.manifestPath, JSON.stringify({ ...f.manifest, units: [{ ...f.manifest.units[0], configFile: link }] }))
    expect(() => f.provision()).toThrow()
  })
})
