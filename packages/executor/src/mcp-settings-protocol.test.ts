import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ManagedMcpSettingsProtocol } from './mcp-settings-protocol.js'
import { readSecureConfig, writeDashboardMcpServers } from './mcp-managed-config.js'

const roots: string[] = []
function fixture(now = () => Date.now()) {
  const parent = join(process.cwd(), '.settings-test-work')
  mkdirSync(parent, { recursive: true })
  const root = mkdtempSync(join(parent, 'mcp-'))
  roots.push(root)
  const path = join(root, 'executor.json')
  writeFileSync(path, JSON.stringify({ version: 1, preserved: { target: 'original' }, mcpServers: [
    { name: 'first', command: 'secret-command-1', args: ['secret-arg-1'] },
    { name: 'second', command: 'secret-command-2', args: ['secret-arg-2'] },
  ] }), { mode: 0o600 })
  const protocol = new ManagedMcpSettingsProtocol(path, 'workspace', 'installation', now)
  const activate = vi.fn(), close = vi.fn().mockResolvedValue(undefined)
  const prepare = vi.fn().mockResolvedValue({ activate, close })
  return { root, path, protocol, prepare, activate, close }
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true }) })

describe('durable managed MCP patch protocol', () => {
  it('preserves untouched secrets and unrelated keys; returns names only and commits revision with receipt', async () => {
    const { path, protocol, prepare } = fixture()
    const status = await protocol.status()
    expect(status).toMatchObject({ editProtocol: 'patch-v1', revision: '1', servers: [{ name: 'first' }, { name: 'second' }] })
    expect(JSON.stringify(status)).not.toContain('secret-command')
    const response = await protocol.patch({ requestId: status.requestId, editToken: status.editToken, expectedRevision: '1',
      operations: [{ op: 'replace', name: 'first', command: 'new-command', args: [] }] }, prepare)
    expect(response).toMatchObject({ ok: true, revision: '2', duplicate: false })
    const saved = JSON.parse(readFileSync(path, 'utf8'))
    expect(saved).toMatchObject({ preserved: { target: 'original' }, mcpServers: [
      { name: 'first', command: 'new-command', args: [] }, { name: 'second', command: 'secret-command-2', args: ['secret-arg-2'] },
    ], _kalaManagedMcp: { revision: '2', receipts: [{ requestId: status.requestId, resultRevision: '2' }] } })
    expect(JSON.stringify(saved._kalaManagedMcp)).not.toContain('new-command')
    expect(prepare).toHaveBeenCalledOnce()
  })

  it('deduplicates A after B, a legacy replacement and restart without reinitializing A', async () => {
    const { path, protocol, prepare } = fixture()
    const first = await protocol.status()
    const a = { requestId: first.requestId, editToken: first.editToken, expectedRevision: first.revision,
      operations: [{ op: 'replace', name: 'first', command: 'A', args: [] }] }
    await protocol.patch(a, prepare)
    const second = await protocol.status()
    await protocol.patch({ requestId: second.requestId, editToken: second.editToken, expectedRevision: second.revision,
      operations: [{ op: 'replace', name: 'first', command: 'B', args: [] }] }, prepare)
    await protocol.replace([{ name: 'third', command: 'legacy', args: [] }], prepare)
    const restarted = new ManagedMcpSettingsProtocol(path, 'workspace', 'installation')
    await expect(restarted.patch(a, prepare)).resolves.toMatchObject({ duplicate: true, requestResultRevision: '2', currentRevision: '4' })
    expect(prepare).toHaveBeenCalledTimes(3)
    expect(JSON.parse(readFileSync(path, 'utf8')).mcpServers).toEqual([{ name: 'third', command: 'legacy', args: [] }])
    await expect(restarted.patch({ ...a, operations: [{ op: 'replace', name: 'first', command: 'different', args: [] }] }, prepare)).rejects.toThrow('edit_ticket_reused_with_different_request')
  })

  it('rejects stale/foreign/future/expired tickets, duplicate operations, unknown fields and final-list overflow before preparation', async () => {
    let now = Date.now()
    const { path, protocol, prepare } = fixture(() => now)
    const first = await protocol.status()
    const input = { requestId: first.requestId, editToken: first.editToken, expectedRevision: first.revision,
      operations: [{ op: 'delete', name: 'first' }] }
    await expect(protocol.patch({ ...input, expectedRevision: '2' }, prepare)).rejects.toThrow('configuration_conflict')
    await expect(protocol.patch({ ...input, extra: true }, prepare)).rejects.toThrow()
    await expect(protocol.patch({ ...input, operations: [...input.operations, ...input.operations] }, prepare)).rejects.toThrow()
    await expect(new ManagedMcpSettingsProtocol(path, 'foreign', 'installation', () => now).patch(input, prepare)).rejects.toThrow('expired_or_foreign_edit_ticket')
    now -= 1
    await expect(protocol.patch(input, prepare)).rejects.toThrow('expired_or_foreign_edit_ticket')
    now += 86_400_001
    await expect(protocol.patch(input, prepare)).rejects.toThrow('expired_or_foreign_edit_ticket')
    const fresh = await protocol.status()
    await expect(protocol.patch({ ...input, requestId: fresh.requestId, editToken: fresh.editToken, operations: Array.from({ length: 16 }, (_, index) => ({ op: 'replace', name: `extra${index}`, command: 'x', args: [] })) }, prepare)).rejects.toThrow('at most 16')
    expect(prepare).not.toHaveBeenCalled()
  })

  it('keeps state on failed candidate and concurrent full-file edit and fails closed on a missing or symlinked integrity key', async () => {
    const { root, path, protocol, prepare, close } = fixture()
    const first = await protocol.status()
    const before = readFileSync(path, 'utf8')
    const input = { requestId: first.requestId, editToken: first.editToken, expectedRevision: first.revision,
      operations: [{ op: 'delete', name: 'first' }] }
    await expect(protocol.patch(input, vi.fn().mockRejectedValue(new Error('candidate failed')))).rejects.toThrow('candidate failed')
    expect(readFileSync(path, 'utf8')).toBe(before)
    await expect(protocol.patch(input, async servers => {
      writeFileSync(path, JSON.stringify({ ...JSON.parse(before), unrelatedEditor: true }), { mode: 0o600 })
      return prepare(servers)
    })).rejects.toThrow('changed before replacement')
    expect(close).toHaveBeenCalledOnce()
    expect(JSON.parse(readFileSync(path, 'utf8')).unrelatedEditor).toBe(true)
    const key = join(root, '.mcp-config-integrity.key')
    unlinkSync(key)
    await expect(protocol.status()).rejects.toThrow('mcp_integrity_key_missing')
    writeFileSync(join(root, 'other'), Buffer.alloc(32), { mode: 0o600 })
    symlinkSync(join(root, 'other'), key)
    await expect(protocol.status()).rejects.toThrow('unsafe_mcp_integrity_key')
  })

  it('retains all 512 unexpired receipts, refuses the next mutation, and prunes only after expiry', async () => {
    let now = Date.now()
    const { path, protocol, prepare } = fixture(() => now)
    for (let index = 0; index < 512; index++) {
      const ticket = await protocol.status()
      await protocol.patch({ requestId: ticket.requestId, editToken: ticket.editToken, expectedRevision: ticket.revision,
        operations: [{ op: 'replace', name: 'first', command: `command-${index}`, args: [] }] }, prepare)
    }
    const ticket = await protocol.status()
    const request = { requestId: ticket.requestId, editToken: ticket.editToken, expectedRevision: ticket.revision,
      operations: [{ op: 'delete', name: 'first' }] }
    await expect(protocol.patch(request, prepare)).rejects.toThrow('deduplication_capacity_exceeded')
    expect(JSON.parse(readFileSync(path, 'utf8'))._kalaManagedMcp.receipts).toHaveLength(512)
    now += 86_400_001
    const fresh = await protocol.status()
    await protocol.patch({ ...request, requestId: fresh.requestId, editToken: fresh.editToken }, prepare)
    expect(JSON.parse(readFileSync(path, 'utf8'))._kalaManagedMcp.receipts).toHaveLength(1)
  }, 20_000)

  it('refuses compatibility writers that do not preserve migrated metadata and private-file permissions', async () => {
    const { path, protocol } = fixture()
    await protocol.status()
    expect(() => writeDashboardMcpServers(path, [], readSecureConfig(path))).toThrow('patch-v1 preserving writer')
    chmodSync(path, 0o644)
    await expect(protocol.status()).rejects.toThrow('permissions')
  })
})
