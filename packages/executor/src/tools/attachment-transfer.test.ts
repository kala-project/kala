import { afterEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { lstat, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createSandbox } from '../sandbox.js'
import { createAttachmentTransferTool } from './attachment-transfer.js'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { force: true, recursive: true })
})

async function setup() {
  const root = await mkdtemp(join(process.cwd(), '.attachment-transfer-test-'))
  roots.push(root)
  const tool = createAttachmentTransferTool()
  const sandbox = createSandbox({ roots: [root] })
  const controller = new AbortController()
  const run = async (input: Record<string, unknown>, overrides: Record<string, unknown> = {}) =>
    JSON.parse(await tool.run(input, { sessionId: 'session', callId: 'call', origin: 'host',
      ownerGeneration: '2', signal: controller.signal, sandbox, ...overrides }))
  return { root, run, controller }
}

describe('host attachment transfer', () => {
  it('imports binary data, supports duplicate chunks and repeated finish/status without overwrite', async () => {
    const { root, run } = await setup()
    const data = Buffer.alloc(300_000)
    for (let i = 0; i < data.length; i++) data[i] = i % 256
    const req = { transferId: 'transfer-retry', path: 'image.bin', bytes: data.length,
      sha256: createHash('sha256').update(data).digest('hex') }
    expect(await run({ ...req, action: 'begin' })).toMatchObject({ ok: true, state: 'active', nextOffset: 0 })
    expect(await run({ ...req, action: 'begin' })).toMatchObject({ ok: true, nextOffset: 0 })
    const first = { ...req, action: 'chunk', offset: 0, data: data.subarray(0, 200_000).toString('base64') }
    expect(await run(first)).toMatchObject({ ok: true, nextOffset: 200_000 })
    expect(await run(first)).toMatchObject({ ok: true, nextOffset: 200_000 })
    expect(await run({ ...first, data: Buffer.alloc(200_000).toString('base64') })).toMatchObject({ ok: false, error: 'retry data conflict' })
    expect(await run({ ...req, action: 'chunk', offset: 200_000, data: data.subarray(200_000).toString('base64') }))
      .toMatchObject({ ok: true, nextOffset: data.length })
    expect(await run({ ...req, action: 'finish' })).toMatchObject({ ok: true, state: 'completed', nextOffset: data.length })
    expect(await readFile(join(root, 'image.bin'))).toEqual(data)
    expect(await run({ ...req, action: 'status' })).toMatchObject({ ok: true, state: 'completed' })
    expect(await run({ ...req, action: 'finish' })).toMatchObject({ ok: true, state: 'completed' })
    expect(await run({ ...req, action: 'abort' })).toMatchObject({ ok: true, state: 'completed' })
    expect(await run({ ...req, transferId: 'another-id', action: 'status' }))
      .toMatchObject({ ok: true, state: 'completed', nextOffset: data.length })
    expect(await run({ ...req, transferId: 'another-id', action: 'finish' }))
      .toMatchObject({ ok: true, state: 'completed' })
    expect(await run({ ...req, transferId: 'another-id', action: 'abort' }))
      .toMatchObject({ ok: true, state: 'absent' })
    expect(await run({ ...req, action: 'begin' }, { ownerGeneration: '3' })).toMatchObject({ ok: false, error: 'transfer identity conflict' })
    expect(await run({ ...req, action: 'begin' }, { sessionId: 'forged' })).toMatchObject({ ok: false, error: 'transfer identity conflict' })
  })

  it('rejects mismatched digest, out-of-bounds chunks, symlink parents and existing files; abort removes staging', async () => {
    const { root, run } = await setup()
    const req = { transferId: 'transfer-digest', path: 'target.bin', bytes: 3, sha256: '0'.repeat(64) }
    expect(await run({ ...req, action: 'begin' })).toMatchObject({ ok: true })
    expect(await run({ ...req, action: 'chunk', offset: 0, data: Buffer.from('abcd').toString('base64') }))
      .toMatchObject({ ok: false })
    expect(await run({ ...req, action: 'chunk', offset: 0, data: Buffer.from('abc').toString('base64') }))
      .toMatchObject({ ok: true, nextOffset: 3 })
    expect(await run({ ...req, action: 'finish' })).toMatchObject({ ok: false, error: 'attachment size or SHA-256 mismatch' })
    await expect(lstat(join(root, 'target.bin'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await run({ ...req, action: 'abort' })).toMatchObject({ ok: true, state: 'aborted' })
    await writeFile(join(root, 'taken.bin'), 'keep')
    expect(await run({ ...req, transferId: 'taken', path: 'taken.bin', action: 'begin' })).toMatchObject({ ok: false, error: 'target already exists' })
    await mkdir(join(root, 'safe'))
    await symlink(join(root, 'safe'), join(root, 'alias'))
    expect(await run({ ...req, transferId: 'alias', path: 'alias/a.bin', action: 'begin' }))
      .toMatchObject({ ok: false, error: 'target parent must be a real directory' })
    expect(await run({ ...req, transferId: 'outside', path: '../outside.bin', action: 'begin' }))
      .toMatchObject({ ok: false, error: 'target is outside workspace' })
    expect(await run({ ...req, transferId: 'forged', action: 'begin' }, { origin: undefined }))
      .toMatchObject({ ok: false, error: 'Host admission required' })
  })

  it('allows Host calls without generation in Portable mode but cannot switch generation mid-transfer', async () => {
    const { run } = await setup()
    const data = Buffer.from([0, 1, 255])
    const req = { action: 'begin', transferId: 'portable', path: 'portable.bin', bytes: 3,
      sha256: createHash('sha256').update(data).digest('hex') }
    expect(await run(req, { ownerGeneration: undefined })).toMatchObject({ ok: true })
    expect(await run({ ...req, action: 'status' }, { ownerGeneration: '2' }))
      .toMatchObject({ ok: false, error: 'transfer identity conflict' })
  })

  it('accepts the full 16 MiB binary limit in 256 KiB chunks', async () => {
    const { root, run } = await setup()
    const chunk = Buffer.alloc(256 * 1024, 0xff)
    const hash = createHash('sha256')
    for (let i = 0; i < 64; i++) hash.update(chunk)
    const req = { transferId: 'a'.repeat(64), path: 'maximum.bin', bytes: 16 * 1024 * 1024, sha256: hash.digest('hex') }
    expect(await run({ ...req, action: 'begin' })).toMatchObject({ ok: true, nextOffset: 0 })
    for (let i = 0; i < 64; i++) {
      expect(await run({ ...req, action: 'chunk', offset: i * chunk.length, data: chunk.toString('base64') }))
        .toMatchObject({ ok: true, nextOffset: (i + 1) * chunk.length })
    }
    expect(await run({ ...req, action: 'finish' })).toMatchObject({ ok: true, state: 'completed' })
    expect((await lstat(join(root, 'maximum.bin'))).size).toBe(req.bytes)
    expect(await run({ ...req, transferId: 'oversize', bytes: req.bytes + 1, action: 'begin' }))
      .toMatchObject({ ok: false, error: 'invalid transfer request' })
  })

  it('only replaces an existing regular file with explicit overwrite and allows later chunks to omit the flag', async () => {
    const { root, run } = await setup()
    await writeFile(join(root, 'replace.bin'), 'old')
    const contents = Buffer.from([1, 2, 0, 255])
    const req = { transferId: 'replace', path: 'replace.bin', bytes: contents.length,
      sha256: createHash('sha256').update(contents).digest('hex') }
    expect(await run({ ...req, action: 'begin' })).toMatchObject({ ok: false, error: 'target already exists' })
    expect(await run({ ...req, action: 'begin', overwrite: true })).toMatchObject({ ok: true, state: 'active' })
    expect(await run({ ...req, action: 'chunk', offset: 0, data: contents.toString('base64') }))
      .toMatchObject({ ok: true, nextOffset: contents.length })
    expect(await run({ ...req, action: 'finish' })).toMatchObject({ ok: true, state: 'completed' })
    expect(await readFile(join(root, 'replace.bin'))).toEqual(contents)
  })
})
