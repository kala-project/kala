import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import type { PostgresClaimClient, PostgresClaimPool, S3ClaimClient } from './fresh-install-claim.js'
import { advanceRecoveryCheckpoints, assertRecoveryCheckpoint, initializeRecoveryCheckpoints, readPostgresRecoveryCheckpoint, readS3RecoveryCheckpoint, stateKeySha256 } from './recovery-checkpoint.js'

const installationId = '018f5f8e-7f3d-7cc1-9c2b-52f7d83a6e41'
const nextId = '018f5f8e-7f3d-7cc1-9c2b-52f7d83a6e42'
const keySha256 = stateKeySha256(Buffer.alloc(32, 7))
const initial = { installationId, checkpointId: installationId, keySha256 }
const next = { ...initial, checkpointId: nextId }

class Pg implements PostgresClaimPool {
  row: typeof initial | undefined
  failUpdate = false
  async query<Row extends Record<string, unknown>>(text: string, values: readonly unknown[] = []): Promise<{ rows: Row[]; rowCount: number }> {
    if (text.startsWith('SELECT installation_id')) {
      const rows = this.row ? [{ installation_id: this.row.installationId, checkpoint_id: this.row.checkpointId, key_sha256: this.row.keySha256 }] : []
      return { rows: rows as Row[], rowCount: rows.length }
    }
    if (text.startsWith('INSERT INTO')) { this.row = { ...initial }; return { rows: [], rowCount: 1 } }
    if (text.startsWith('UPDATE')) {
      if (this.failUpdate) throw new Error('injected update failure')
      if (!this.row || this.row.checkpointId !== values[1]) return { rows: [], rowCount: 0 }
      this.row = { ...this.row, checkpointId: String(values[3]) }; return { rows: [], rowCount: 1 }
    }
    return { rows: [], rowCount: 0 }
  }
  async connect(): Promise<PostgresClaimClient> { return { query: this.query.bind(this), release: () => undefined } }
  async end(): Promise<void> {}
}
class S3 implements S3ClaimClient {
  body: string | undefined
  async send(command: unknown): Promise<unknown> {
    const request = command as { constructor: { name: string }; input: { Body?: string; IfNoneMatch?: string; IfMatch?: string } }
    if (request.constructor.name === 'GetObjectCommand') {
      if (!this.body) throw new Error('NoSuchKey')
      const body = this.body
      return { ETag: `"${createHash('md5').update(body).digest('hex')}"`, Body: { async *[Symbol.asyncIterator]() { yield Buffer.from(body) } } }
    }
    if (request.constructor.name === 'PutObjectCommand') {
      if (request.input.IfNoneMatch === '*' && this.body) throw new Error('precondition failed')
      if (request.input.IfMatch && request.input.IfMatch !== `"${createHash('md5').update(this.body ?? '').digest('hex')}"`) throw new Error('stale S3 ETag')
      this.body = request.input.Body
      return {}
    }
    throw new Error('unexpected S3 operation')
  }
}

describe('offline PG/S3 recovery checkpoint', () => {
  it('initializes all authorities and rejects missing, mixed or wrong-key recovery sets', async () => {
    const control = new Pg(); const runtime = new Pg(); const objectStore = new S3()
    await expect(readPostgresRecoveryCheckpoint(control)).rejects.toThrow('missing')
    await initializeRecoveryCheckpoints({ control, runtime, objectStore, bucket: 'bucket', checkpoint: initial })
    expect(await readPostgresRecoveryCheckpoint(control)).toEqual(initial)
    expect(await readS3RecoveryCheckpoint(objectStore, 'bucket')).toEqual(initial)
    expect(() => assertRecoveryCheckpoint(initial, { ...initial, keySha256: stateKeySha256(Buffer.alloc(32, 8)) }, 'Runtime')).toThrow('does not match')
    runtime.row = next
    await expect(advanceRecoveryCheckpoints({ control, runtime, objectStore, bucket: 'bucket', previous: initial, next, resumePartial: false })).rejects.toThrow('Partial checkpoint')
    await advanceRecoveryCheckpoints({ control, runtime, objectStore, bucket: 'bucket', previous: initial, next, resumePartial: true })
    expect(await readS3RecoveryCheckpoint(objectStore, 'bucket')).toEqual(next)
    await expect(advanceRecoveryCheckpoints({ control, runtime, objectStore, bucket: 'bucket', previous: initial, next: { ...next, checkpointId: '018f5f8e-7f3d-7cc1-9c2b-52f7d83a6e43' }, resumePartial: true })).rejects.toThrow('unexpected checkpoint')
  })
  it('retains a failed partial transition for explicit same-target retry', async () => {
    const control = new Pg(); const runtime = new Pg(); const objectStore = new S3()
    await initializeRecoveryCheckpoints({ control, runtime, objectStore, bucket: 'bucket', checkpoint: initial })
    runtime.failUpdate = true
    await expect(advanceRecoveryCheckpoints({ control, runtime, objectStore, bucket: 'bucket', previous: initial, next, resumePartial: false })).rejects.toThrow('injected')
    expect(control.row).toEqual(next)
    expect(runtime.row).toEqual(initial)
    await expect(advanceRecoveryCheckpoints({ control, runtime, objectStore, bucket: 'bucket', previous: initial, next, resumePartial: false })).rejects.toThrow('Partial checkpoint')
    runtime.failUpdate = false
    await advanceRecoveryCheckpoints({ control, runtime, objectStore, bucket: 'bucket', previous: initial, next, resumePartial: true })
    expect(await readPostgresRecoveryCheckpoint(runtime)).toEqual(next)
  })
})
