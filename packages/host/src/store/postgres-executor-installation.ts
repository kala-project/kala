import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

import {
  isExecutorInstallStatusTransitionAllowed,
  type CreateExecutorInstall,
  type ExecutorInstallEvent,
  type ExecutorInstallEventMetadata,
  type ExecutorInstallStatus,
  type ExecutorInstallStatusSnapshot,
  type UpdateExecutorInstall,
} from '@agent-kernel/shared'

import type { HotStateDatabase, HotStateSqlExecutor } from '../tenant-runtime/postgres-hot-state.js'
import {
  ExecutorInstallationError,
  type ClaimedExecutorInstallation,
  type CreatedExecutorInstallation,
  type ExecutorInstallationStorage,
  type ExecutorInstallationTenantAttribution,
  type ManagedExecutorInstallationBinding,
} from './executor-installation.js'
import { privateCloudStorageTable } from './postgres-private-cloud-storage.js'

const DEFAULT_TTL_MS = 15 * 60_000

type InstallationRecord = ExecutorInstallStatusSnapshot & {
  bootstrapHash: string
  setupCodeHash?: string
  bootstrapDownloadedAt?: string
  redeemedAt?: string
  workspaceId?: string
  events: ExecutorInstallEvent[]
}
type InstallationRow = Record<string, unknown> & { record: unknown }
type IdempotencyRow = Record<string, unknown> & { record: unknown }

/** Transactional installation state scoped by an organization id from trusted runtime authority. */
export class PostgresExecutorInstallationStore implements ExecutorInstallationStorage {
  readonly #organizationId: string
  readonly #installations: string
  readonly #idempotency: string

  constructor(
    readonly database: HotStateDatabase,
    organizationId: string,
    private readonly ttlMs = DEFAULT_TTL_MS,
    options: { schema?: string } = {},
  ) {
    if (!organizationId) throw new TypeError('organizationId must be a non-empty trusted identifier')
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1) throw new RangeError('ttlMs must be a positive safe integer')
    this.#organizationId = organizationId
    this.#installations = privateCloudStorageTable(options.schema, 'executor_installations')
    this.#idempotency = privateCloudStorageTable(options.schema, 'executor_installation_idempotency')
  }

  async load(): Promise<void> {
    await this.database.query(`SELECT 1 FROM ${this.#installations} WHERE organization_id = $1 LIMIT 1`, [this.#organizationId])
  }

  async create(input: CreateExecutorInstall, idempotencyKey?: string, tenant?: ExecutorInstallationTenantAttribution): Promise<CreatedExecutorInstallation> {
    if (tenant?.organizationId && tenant.organizationId !== this.#organizationId) {
      throw new ExecutorInstallationError('tenant_attribution_mismatch', 403)
    }
    return this.database.transaction(async (transaction) => {
      if (idempotencyKey) {
        await transaction.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [JSON.stringify([this.#organizationId, idempotencyKey])])
        const replay = await transaction.query<IdempotencyRow>(`SELECT i.record
          FROM ${this.#idempotency} k
          JOIN ${this.#installations} i
            ON i.organization_id = k.organization_id AND i.installation_id = k.installation_id
          WHERE k.organization_id = $1 AND k.idempotency_key = $2`, [this.#organizationId, idempotencyKey])
        if (replay.rows[0]) throw new ExecutorInstallationError('idempotency_replayed', 409, snapshot(parseRecord(replay.rows[0].record)))
      }

      const now = new Date()
      const id = `inst_${randomBytes(12).toString('base64url')}`
      const setupCode = createSetupCode()
      const record: InstallationRecord = {
        id,
        ...input,
        organizationId: this.#organizationId,
        ...(tenant?.principal ? { principal: tenant.principal } : {}),
        ...(tenant?.organizationRole ? { organizationRole: tenant.organizationRole } : {}),
        status: 'created',
        seq: 0,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + this.ttlMs).toISOString(),
        bootstrapHash: hashToken(`unclaimed:${randomBytes(32).toString('base64url')}`),
        setupCodeHash: hashToken(setupCode),
        events: [{ installationId: id, seq: 0, timestamp: now.toISOString(), status: 'created' }],
      }
      await transaction.query(`INSERT INTO ${this.#installations}
          (organization_id, installation_id, record, updated_at)
        VALUES ($1, $2, $3::jsonb, clock_timestamp())`, [this.#organizationId, id, JSON.stringify(record)])
      if (idempotencyKey) {
        await transaction.query(`INSERT INTO ${this.#idempotency}
            (organization_id, idempotency_key, installation_id)
          VALUES ($1, $2, $3)`, [this.#organizationId, idempotencyKey, id])
      }
      return { install: snapshot(record), setupCode }
    })
  }

  async claim(setupCode: string): Promise<ClaimedExecutorInstallation | undefined> {
    const normalized = normalizeSetupCode(setupCode)
    if (!normalized) return undefined
    return this.database.transaction(async (transaction) => {
      const selected = await transaction.query<InstallationRow>(`SELECT record FROM ${this.#installations}
        WHERE organization_id = $1 AND record ->> 'setupCodeHash' = $2 FOR UPDATE`, [this.#organizationId, hashToken(normalized)])
      const record = selected.rows[0] ? parseRecord(selected.rows[0].record) : undefined
      if (!record || record.status !== 'created' || record.bootstrapDownloadedAt) return undefined
      const bootstrap = `ak_install_${randomBytes(32).toString('base64url')}`
      record.bootstrapHash = hashToken(bootstrap)
      delete record.setupCodeHash
      record.bootstrapDownloadedAt = new Date().toISOString()
      transition(record, 'bootstrap_downloaded')
      await this.#write(transaction, record)
      return { install: snapshot(record), bootstrap }
    })
  }

  async get(id: string): Promise<ExecutorInstallStatusSnapshot | undefined> {
    return this.database.transaction(async (transaction) => {
      const record = await this.#activeRecord(transaction, id)
      return record ? snapshot(record) : undefined
    })
  }

  async managedBinding(id: string): Promise<ManagedExecutorInstallationBinding | undefined> {
    return this.database.transaction(async (transaction) => {
      const record = await this.#activeRecord(transaction, id)
      return record?.workspaceId
        ? { id: record.id, workspaceId: record.workspaceId, organizationId: this.#organizationId }
        : undefined
    })
  }

  async managedBindingsForWorkspace(workspaceId: string): Promise<ManagedExecutorInstallationBinding[]> {
    return this.database.transaction(async (transaction) => {
      const selected = await transaction.query<InstallationRow>(`SELECT record FROM ${this.#installations}
        WHERE organization_id = $1 AND record ->> 'workspaceId' = $2 FOR UPDATE`, [this.#organizationId, workspaceId])
      const bindings: ManagedExecutorInstallationBinding[] = []
      for (const row of selected.rows) {
        const record = parseRecord(row.record)
        if (expireIfNeeded(record)) await this.#write(transaction, record)
        if (record.workspaceId === workspaceId) bindings.push({ id: record.id, workspaceId, organizationId: this.#organizationId })
      }
      return bindings
    })
  }

  async events(id: string, afterSeq = -1): Promise<readonly ExecutorInstallEvent[] | undefined> {
    return this.database.transaction(async (transaction) => {
      const record = await this.#activeRecord(transaction, id)
      return record?.events.filter((event) => event.seq > afterSeq)
    })
  }

  async update(id: string, input: UpdateExecutorInstall): Promise<ExecutorInstallStatusSnapshot | undefined> {
    return this.database.transaction(async (transaction) => {
      const record = await this.#activeRecord(transaction, id)
      if (!record || record.status !== 'created' || record.bootstrapDownloadedAt) return undefined
      Object.assign(record, input, { updatedAt: new Date().toISOString() })
      await this.#write(transaction, record)
      return snapshot(record)
    })
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.database.query(`DELETE FROM ${this.#installations}
      WHERE organization_id = $1 AND installation_id = $2`, [this.#organizationId, id])
    return result.rowCount !== 0
  }

  async authenticate(id: string, bootstrap: string | undefined): Promise<boolean> {
    if (!bootstrap) return false
    return this.database.transaction(async (transaction) => {
      const record = await this.#activeRecord(transaction, id)
      return Boolean(record && safeHashEqual(record.bootstrapHash, hashToken(bootstrap)))
    })
  }

  async markBootstrapDownloaded(bootstrap: string): Promise<ExecutorInstallStatusSnapshot | undefined> {
    return this.database.transaction(async (transaction) => {
      const selected = await transaction.query<InstallationRow>(`SELECT record FROM ${this.#installations}
        WHERE organization_id = $1 AND record ->> 'bootstrapHash' = $2 FOR UPDATE`, [this.#organizationId, hashToken(bootstrap)])
      const record = selected.rows[0] ? parseRecord(selected.rows[0].record) : undefined
      if (!record || record.bootstrapDownloadedAt || record.redeemedAt || record.status !== 'created') return undefined
      record.bootstrapDownloadedAt = new Date().toISOString()
      transition(record, 'bootstrap_downloaded')
      await this.#write(transaction, record)
      return snapshot(record)
    })
  }

  async reportClient(id: string, bootstrap: string, status: ExecutorInstallStatus, errorCode?: string, metadata?: ExecutorInstallEventMetadata): Promise<ExecutorInstallStatusSnapshot> {
    return this.database.transaction(async (transaction) => {
      const record = await this.#requireBootstrap(transaction, id, bootstrap)
      if (status === 'online' || status === 'completed') throw new ExecutorInstallationError('host_observed_status_required', 409)
      transition(record, status, errorCode, metadata)
      if (status === 'pairing_pending') transition(record, 'paired')
      await this.#write(transaction, record)
      return snapshot(record)
    })
  }

  async approve(id: string): Promise<ExecutorInstallStatusSnapshot | undefined> {
    return this.#pendingDecision(id, 'paired')
  }

  async reject(id: string): Promise<ExecutorInstallStatusSnapshot | undefined> {
    return this.#pendingDecision(id, 'rejected')
  }

  async redeem(id: string, bootstrap: string, workspaceId: string): Promise<ExecutorInstallStatusSnapshot> {
    return this.database.transaction(async (transaction) => {
      const record = await this.#requireBootstrap(transaction, id, bootstrap)
      if (record.status !== 'paired') throw new ExecutorInstallationError('installation_not_approved', 409)
      if (record.redeemedAt) throw new ExecutorInstallationError('installation_already_redeemed', 409)
      record.redeemedAt = new Date().toISOString()
      record.workspaceId = workspaceId
      await this.#write(transaction, record)
      return snapshot(record)
    })
  }

  async markOnline(id: string, workspaceId: string, metadata?: ExecutorInstallEventMetadata): Promise<ExecutorInstallStatusSnapshot | undefined> {
    return this.database.transaction(async (transaction) => {
      const record = await this.#activeRecord(transaction, id)
      if (!record || record.workspaceId !== workspaceId || record.status !== 'starting') return undefined
      transition(record, 'online', undefined, metadata)
      transition(record, 'completed', undefined, metadata)
      await this.#write(transaction, record)
      return snapshot(record)
    })
  }

  async #pendingDecision(id: string, status: 'paired' | 'rejected'): Promise<ExecutorInstallStatusSnapshot | undefined> {
    return this.database.transaction(async (transaction) => {
      const record = await this.#activeRecord(transaction, id)
      if (!record || record.status !== 'pairing_pending') return undefined
      transition(record, status)
      await this.#write(transaction, record)
      return snapshot(record)
    })
  }

  async #activeRecord(transaction: HotStateSqlExecutor, id: string): Promise<InstallationRecord | undefined> {
    const selected = await transaction.query<InstallationRow>(`SELECT record FROM ${this.#installations}
      WHERE organization_id = $1 AND installation_id = $2 FOR UPDATE`, [this.#organizationId, id])
    const record = selected.rows[0] ? parseRecord(selected.rows[0].record) : undefined
    if (record && expireIfNeeded(record)) await this.#write(transaction, record)
    return record
  }

  async #requireBootstrap(transaction: HotStateSqlExecutor, id: string, bootstrap: string): Promise<InstallationRecord> {
    const record = await this.#activeRecord(transaction, id)
    if (!record || !safeHashEqual(record.bootstrapHash, hashToken(bootstrap))) {
      throw new ExecutorInstallationError('invalid_installation_credential', 401)
    }
    return record
  }

  async #write(transaction: HotStateSqlExecutor, record: InstallationRecord): Promise<void> {
    const result = await transaction.query(`UPDATE ${this.#installations}
      SET record = $3::jsonb, updated_at = clock_timestamp()
      WHERE organization_id = $1 AND installation_id = $2`, [this.#organizationId, record.id, JSON.stringify(record)])
    if (result.rowCount !== 1) throw new Error('executor installation disappeared during transaction')
  }
}

function expireIfNeeded(record: InstallationRecord): boolean {
  if (Date.parse(record.expiresAt) > Date.now() || !['created', 'pairing_pending'].includes(record.status)) return false
  transition(record, 'expired')
  return true
}

function transition(record: InstallationRecord, status: ExecutorInstallStatus, errorCode?: string, metadata?: ExecutorInstallEventMetadata): void {
  if (!isExecutorInstallStatusTransitionAllowed(record.status, status, record.mode)) {
    throw new ExecutorInstallationError(`invalid_installation_transition:${record.status}:${status}`, 409)
  }
  const timestamp = new Date().toISOString()
  record.status = status
  record.seq += 1
  record.updatedAt = timestamp
  if (errorCode) record.errorCode = errorCode
  record.events.push({ installationId: record.id, seq: record.seq, timestamp, status, ...(errorCode ? { errorCode } : {}), ...(metadata ? { metadata } : {}) })
}

function snapshot(record: InstallationRecord): ExecutorInstallStatusSnapshot {
  const { bootstrapHash: _bootstrapHash, setupCodeHash: _setupCodeHash, bootstrapDownloadedAt: _downloaded, redeemedAt: _redeemed, workspaceId: _workspaceId, events: _events, ...value } = record
  return { ...value }
}

function parseRecord(value: unknown): InstallationRecord {
  const parsed = typeof value === 'string' ? JSON.parse(value) as unknown : value
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid executor installation record returned by PostgreSQL')
  const record = parsed as InstallationRecord
  if (typeof record.id !== 'string' || typeof record.bootstrapHash !== 'string' || !Array.isArray(record.events) || (record.privilegeMode !== 'restricted' && record.privilegeMode !== 'privileged')) {
    throw new Error('invalid executor installation record returned by PostgreSQL')
  }
  return record
}

function createSetupCode(): string { return randomBytes(5).toString('hex').toUpperCase() }
function normalizeSetupCode(value: string): string | undefined { const code = value.replaceAll('-', '').trim().toUpperCase(); return /^[A-F0-9]{10}$/u.test(code) ? code : undefined }
function hashToken(token: string): string { return `sha256:${createHash('sha256').update(token).digest('hex')}` }
function safeHashEqual(left: string, right: string): boolean { const a = Buffer.from(left); const b = Buffer.from(right); return a.length === b.length && timingSafeEqual(a, b) }
