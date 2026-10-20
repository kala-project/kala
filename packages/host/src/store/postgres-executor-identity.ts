import { randomBytes } from 'node:crypto'

import type { HotStateDatabase, HotStateSqlExecutor } from '../tenant-runtime/postgres-hot-state.js'
import {
  hashToken,
  type ExecutorIdentityStorage,
  type ExecutorInvite,
  type ExecutorInviteSummary,
  type ExecutorPairingSummary,
  type StoredExecutorIdentity,
} from './executor-identity.js'
import { privateCloudStorageTable } from './postgres-private-cloud-storage.js'

const EXECUTOR_INVITE_TTL_MS = 7 * 24 * 60 * 60_000
const PAIRING_TTL_MS = 10 * 60_000

type RecordKind = 'identity' | 'invite' | 'pairing'
type InviteRecord = ExecutorInviteSummary & { inviteHash: string }
type PairingRecord = ExecutorPairingSummary & { claimHash: string }
type StoredRow = { record_id: string; record: unknown }

/** PostgreSQL identity authority scoped to a trusted organization and Runtime Unit. */
export class PostgresExecutorIdentityStore implements ExecutorIdentityStorage {
  readonly #organizationId: string
  readonly #unitId: string
  readonly #table: string

  constructor(
    readonly database: HotStateDatabase,
    organizationId: string,
    unitId: string,
    options: { schema?: string } = {},
  ) {
    if (!organizationId) throw new TypeError('organizationId must be a non-empty trusted identifier')
    if (!unitId) throw new TypeError('unitId must be a non-empty trusted identifier')
    this.#organizationId = organizationId
    this.#unitId = unitId
    this.#table = privateCloudStorageTable(options.schema, 'executor_identities')
  }

  async load(): Promise<void> {
    await this.database.query(`SELECT 1 FROM ${this.#table} WHERE organization_id = $1 AND unit_id = $2 LIMIT 1`, this.#scope())
  }

  async snapshot(): Promise<readonly StoredExecutorIdentity[]> {
    const rows = await this.#records('identity')
    return rows.map((row) => parseIdentity(row.record)).filter((entry) => !entry.revokedAt)
  }

  async provisionWorkspace(workspaceId: string, label?: string, installId?: string): Promise<string> {
    return this.database.transaction(async (transaction) => this.#provision(transaction, workspaceId, label, installId))
  }

  async inviteSnapshot(): Promise<readonly ExecutorInviteSummary[]> {
    return (await this.#records('invite')).map((row) => inviteSummary(parseInvite(row.record)))
  }

  async createInvite(input: { label?: string; workspaceId?: string } = {}): Promise<ExecutorInvite> {
    const id = `inv_${randomBytes(12).toString('base64url')}`
    const inviteToken = `ak_invite_${randomBytes(24).toString('base64url')}`
    const now = Date.now()
    const record: InviteRecord = {
      id,
      inviteHash: hashToken(inviteToken),
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + EXECUTOR_INVITE_TTL_MS).toISOString(),
      revoked: false,
      ...(cleanString(input.label) ? { label: cleanString(input.label) } : {}),
      ...(cleanString(input.workspaceId) ? { workspaceId: cleanString(input.workspaceId) } : {}),
    }
    await this.#insert(this.database, 'invite', id, record)
    return inviteValue(record, inviteToken)
  }

  async createPairing(input: { workspaceId: string; label?: string }): Promise<ExecutorPairingSummary & { claimSecret: string }> {
    return this.database.transaction(async (transaction) => {
      await this.#lock(transaction, `pairing:${input.workspaceId}`)
      const pending = (await this.#records('pairing', transaction)).map((row) => parsePairing(row.record))
        .filter((entry) => entry.workspaceId === input.workspaceId && entry.status === 'pending' && Date.parse(entry.expiresAt) > Date.now())
      if (pending.length >= 3) throw new Error('too_many_pending_pairings')
      const id = `pair_${randomBytes(12).toString('base64url')}`
      const claimSecret = `ak_pair_${randomBytes(32).toString('base64url')}`
      const now = Date.now()
      const record: PairingRecord = {
        id,
        code: String(Math.floor(100000 + Math.random() * 900000)),
        workspaceId: input.workspaceId,
        ...(cleanString(input.label) ? { label: cleanString(input.label) } : {}),
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + PAIRING_TTL_MS).toISOString(),
        status: 'pending',
        claimHash: hashToken(claimSecret),
      }
      await this.#insert(transaction, 'pairing', id, record)
      return { ...pairingSummary(record), claimSecret }
    })
  }

  async pairingSnapshot(): Promise<readonly ExecutorPairingSummary[]> {
    return (await this.#records('pairing')).map((row) => pairingSummary(parsePairing(row.record)))
  }

  async decidePairing(id: string, approved: boolean): Promise<ExecutorPairingSummary | undefined> {
    return this.database.transaction(async (transaction) => {
      const record = await this.#recordForUpdate<PairingRecord>(transaction, 'pairing', id, parsePairing)
      if (!record || record.status !== 'pending' || Date.parse(record.expiresAt) <= Date.now()) return undefined
      record.status = approved ? 'approved' : 'rejected'
      await this.#write(transaction, 'pairing', id, record)
      return pairingSummary(record)
    })
  }

  async claimPairing(id: string, secret: string): Promise<{ status: ExecutorPairingSummary['status']; token?: string } | undefined> {
    return this.database.transaction(async (transaction) => {
      const record = await this.#recordForUpdate<PairingRecord>(transaction, 'pairing', id, parsePairing)
      if (!record || record.claimHash !== hashToken(secret)) return undefined
      if (record.status === 'pending' && Date.parse(record.expiresAt) <= Date.now()) {
        record.status = 'expired'
        await this.#write(transaction, 'pairing', id, record)
      }
      if (record.status !== 'approved') return { status: record.status }
      const token = await this.#provision(transaction, record.workspaceId, record.label)
      record.status = 'claimed'
      await this.#write(transaction, 'pairing', id, record)
      return { status: 'claimed', token }
    })
  }

  async consumeInvite(inviteToken: string | undefined, workspaceId: string, label?: string): Promise<{ ok: true; token: string } | { ok: false; reason: string }> {
    if (!inviteToken) return { ok: false, reason: 'missing_invite' }
    return this.database.transaction(async (transaction) => {
      const selected = await transaction.query<StoredRow>(`SELECT record_id, record FROM ${this.#table}
        WHERE organization_id = $1 AND unit_id = $2 AND record_kind = 'invite'
          AND record ->> 'inviteHash' = $3 FOR UPDATE`, [...this.#scope(), hashToken(inviteToken)])
      const row = selected.rows[0]
      if (!row) return { ok: false, reason: 'invalid_invite' }
      const invite = parseInvite(row.record)
      if (invite.revoked || invite.lastUsedAt) return { ok: false, reason: 'invalid_invite' }
      if (Date.parse(invite.expiresAt) <= Date.now()) return { ok: false, reason: 'invite_expired' }
      if (invite.workspaceId && invite.workspaceId !== workspaceId) return { ok: false, reason: 'workspace_identity_mismatch' }
      invite.workspaceId = workspaceId
      invite.lastUsedAt = new Date().toISOString()
      if (!invite.label && cleanString(label)) invite.label = cleanString(label)
      await this.#write(transaction, 'invite', row.record_id, invite)
      return { ok: true, token: await this.#provision(transaction, workspaceId, label) }
    })
  }

  async updateInvite(id: string, input: { label?: string; workspaceId?: string | null }): Promise<ExecutorInviteSummary | undefined> {
    return this.database.transaction(async (transaction) => {
      const invite = await this.#recordForUpdate<InviteRecord>(transaction, 'invite', id, parseInvite)
      if (!invite) return undefined
      if (input.label !== undefined) setOptional(invite, 'label', cleanString(input.label))
      if (input.workspaceId !== undefined) setOptional(invite, 'workspaceId', input.workspaceId === null ? undefined : cleanString(input.workspaceId))
      await this.#write(transaction, 'invite', id, invite)
      return inviteSummary(invite)
    })
  }

  async revokeInvite(id: string): Promise<boolean> {
    return this.database.transaction(async (transaction) => {
      const invite = await this.#recordForUpdate<InviteRecord>(transaction, 'invite', id, parseInvite)
      if (!invite || invite.revoked) return false
      invite.revoked = true
      if (invite.workspaceId) await this.#revokeWorkspace(transaction, invite.workspaceId)
      await this.#write(transaction, 'invite', id, invite)
      return true
    })
  }

  async deleteInvite(id: string): Promise<boolean> {
    const result = await this.database.query(`DELETE FROM ${this.#table}
      WHERE organization_id = $1 AND unit_id = $2 AND record_kind = 'invite' AND record_id = $3`, [...this.#scope(), id])
    return result.rowCount !== 0
  }

  async regenerateInvite(id: string): Promise<ExecutorInvite | undefined> {
    return this.database.transaction(async (transaction) => {
      const invite = await this.#recordForUpdate<InviteRecord>(transaction, 'invite', id, parseInvite)
      if (!invite) return undefined
      if (invite.workspaceId) await this.#revokeWorkspace(transaction, invite.workspaceId)
      const inviteToken = `ak_invite_${randomBytes(24).toString('base64url')}`
      invite.inviteHash = hashToken(inviteToken)
      invite.revoked = false
      invite.createdAt = new Date().toISOString()
      invite.expiresAt = new Date(Date.now() + EXECUTOR_INVITE_TTL_MS).toISOString()
      delete invite.workspaceId
      delete invite.lastUsedAt
      await this.#write(transaction, 'invite', id, invite)
      return inviteValue(invite, inviteToken)
    })
  }

  async resolveToken(token: string | undefined): Promise<StoredExecutorIdentity | undefined> {
    if (!token) return undefined
    const selected = await this.database.query<StoredRow>(`SELECT record_id, record FROM ${this.#table}
      WHERE organization_id = $1 AND unit_id = $2 AND record_kind = 'identity'
        AND record ->> 'tokenHash' = $3 AND NOT (record ? 'revokedAt') LIMIT 1`, [...this.#scope(), hashToken(token)])
    return selected.rows[0] ? parseIdentity(selected.rows[0].record) : undefined
  }

  async rotateWorkspaceCredential(workspaceId: string): Promise<string> {
    return this.database.transaction(async (transaction) => {
      await this.#lock(transaction, `workspace:${workspaceId}`)
      const current = await this.#activeWorkspaceIdentity(transaction, workspaceId)
      if (!current) throw new Error('executor identity not found')
      current.record.revokedAt = new Date().toISOString()
      await this.#write(transaction, 'identity', current.id, current.record)
      return this.#insertIdentity(transaction, workspaceId, current.record.label, current.record.installId, (current.record.credentialVersion ?? 1) + 1)
    })
  }

  async markSeen(token: string | undefined): Promise<void> {
    if (!token) return
    await this.database.query(`UPDATE ${this.#table}
      SET record = jsonb_set(record, '{lastSeenAt}', to_jsonb(clock_timestamp()::text)), updated_at = clock_timestamp()
      WHERE organization_id = $1 AND unit_id = $2 AND record_kind = 'identity'
        AND record ->> 'tokenHash' = $3 AND NOT (record ? 'revokedAt')`, [...this.#scope(), hashToken(token)])
  }

  async revokeWorkspace(workspaceId: string): Promise<boolean> {
    return this.database.transaction(async (transaction) => this.#revokeWorkspace(transaction, workspaceId))
  }

  async #provision(transaction: HotStateSqlExecutor, workspaceId: string, label?: string, installId?: string): Promise<string> {
    await this.#lock(transaction, `workspace:${workspaceId}`)
    await this.#revokeWorkspace(transaction, workspaceId, false)
    return this.#insertIdentity(transaction, workspaceId, label, installId, 1)
  }

  async #insertIdentity(transaction: HotStateSqlExecutor, workspaceId: string, label?: string, installId?: string, credentialVersion?: number): Promise<string> {
    const token = `ak_exec_${randomBytes(32).toString('base64url')}`
    const now = new Date().toISOString()
    const record: StoredExecutorIdentity = {
      tokenHash: hashToken(token),
      workspaceId,
      ...(installId ? { installId } : {}),
      ...(cleanString(label) ? { label: cleanString(label) } : {}),
      createdAt: now,
      lastSeenAt: now,
      ...(credentialVersion && credentialVersion > 1 ? { credentialVersion } : {}),
    }
    await this.#insert(transaction, 'identity', `exec_${randomBytes(12).toString('base64url')}`, record)
    return token
  }

  async #revokeWorkspace(transaction: HotStateSqlExecutor, workspaceId: string, lock = true): Promise<boolean> {
    if (lock) await this.#lock(transaction, `workspace:${workspaceId}`)
    const result = await transaction.query(`UPDATE ${this.#table}
      SET record = jsonb_set(record, '{revokedAt}', to_jsonb(clock_timestamp()::text)), updated_at = clock_timestamp()
      WHERE organization_id = $1 AND unit_id = $2 AND record_kind = 'identity'
        AND record ->> 'workspaceId' = $3 AND NOT (record ? 'revokedAt')`, [...this.#scope(), workspaceId])
    return result.rowCount !== 0
  }

  async #activeWorkspaceIdentity(transaction: HotStateSqlExecutor, workspaceId: string): Promise<{ id: string; record: StoredExecutorIdentity } | undefined> {
    const selected = await transaction.query<StoredRow>(`SELECT record_id, record FROM ${this.#table}
      WHERE organization_id = $1 AND unit_id = $2 AND record_kind = 'identity'
        AND record ->> 'workspaceId' = $3 AND NOT (record ? 'revokedAt') FOR UPDATE`, [...this.#scope(), workspaceId])
    const row = selected.rows[0]
    return row ? { id: row.record_id, record: parseIdentity(row.record) } : undefined
  }

  async #recordForUpdate<T>(transaction: HotStateSqlExecutor, kind: RecordKind, id: string, parse: (value: unknown) => T): Promise<T | undefined> {
    const selected = await transaction.query<StoredRow>(`SELECT record_id, record FROM ${this.#table}
      WHERE organization_id = $1 AND unit_id = $2 AND record_kind = $3 AND record_id = $4 FOR UPDATE`, [...this.#scope(), kind, id])
    return selected.rows[0] ? parse(selected.rows[0].record) : undefined
  }

  async #records(kind: RecordKind, executor: HotStateSqlExecutor = this.database): Promise<StoredRow[]> {
    const selected = await executor.query<StoredRow>(`SELECT record_id, record FROM ${this.#table}
      WHERE organization_id = $1 AND unit_id = $2 AND record_kind = $3 ORDER BY updated_at, record_id`, [...this.#scope(), kind])
    return selected.rows
  }

  async #insert(executor: HotStateSqlExecutor, kind: RecordKind, id: string, record: object): Promise<void> {
    await executor.query(`INSERT INTO ${this.#table}
      (organization_id, unit_id, record_kind, record_id, record, updated_at)
      VALUES ($1, $2, $3, $4, $5::jsonb, clock_timestamp())`, [...this.#scope(), kind, id, JSON.stringify(record)])
  }

  async #write(executor: HotStateSqlExecutor, kind: RecordKind, id: string, record: object): Promise<void> {
    await executor.query(`UPDATE ${this.#table} SET record = $5::jsonb, updated_at = clock_timestamp()
      WHERE organization_id = $1 AND unit_id = $2 AND record_kind = $3 AND record_id = $4`, [...this.#scope(), kind, id, JSON.stringify(record)])
  }

  async #lock(transaction: HotStateSqlExecutor, key: string): Promise<void> {
    await transaction.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [JSON.stringify([this.#organizationId, this.#unitId, key])])
  }

  #scope(): [string, string] {
    return [this.#organizationId, this.#unitId]
  }
}

function parseObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('invalid executor identity record')
  return value as Record<string, unknown>
}

function parseIdentity(value: unknown): StoredExecutorIdentity {
  const record = parseObject(value)
  if (typeof record.tokenHash !== 'string' || typeof record.workspaceId !== 'string' || typeof record.createdAt !== 'string') throw new Error('invalid executor identity record')
  return record as StoredExecutorIdentity
}

function parseInvite(value: unknown): InviteRecord {
  const record = parseObject(value)
  if (typeof record.id !== 'string' || typeof record.inviteHash !== 'string' || typeof record.createdAt !== 'string' || typeof record.expiresAt !== 'string' || typeof record.revoked !== 'boolean') throw new Error('invalid executor invite record')
  return record as InviteRecord
}

function parsePairing(value: unknown): PairingRecord {
  const record = parseObject(value)
  if (typeof record.id !== 'string' || typeof record.claimHash !== 'string' || typeof record.workspaceId !== 'string' || typeof record.status !== 'string') throw new Error('invalid executor pairing record')
  return record as PairingRecord
}

function inviteSummary(record: InviteRecord): ExecutorInviteSummary {
  const { inviteHash: _inviteHash, ...summary } = record
  return summary
}

function inviteValue(record: InviteRecord, inviteToken: string): ExecutorInvite {
  const { revoked: _revoked, inviteHash: _inviteHash, lastUsedAt, ...value } = record
  return { ...value, ...(lastUsedAt ? { lastUsedAt } : {}), inviteToken }
}

function pairingSummary(record: PairingRecord): ExecutorPairingSummary {
  const { claimHash: _claimHash, ...summary } = record
  return summary.status === 'pending' && Date.parse(summary.expiresAt) <= Date.now() ? { ...summary, status: 'expired' } : summary
}

function cleanString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function setOptional<T extends object, K extends keyof T>(target: T, key: K, value: T[K] | undefined): void {
  if (value === undefined) delete target[key]
  else target[key] = value
}
