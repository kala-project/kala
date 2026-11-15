import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto'
import { chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import type { MemoDocument } from '../memo-store.js'
import { DagStore } from '../dag/store.js'
import { checkSettingsPrecondition, nextSettingsRevision, settingsRevision, type SettingsWriteOptions } from '../settings-concurrency.js'
import { migrateSqliteSettings } from './settings-sqlite-migration.js'

const KEY_BYTES = 32
const NONCE_BYTES = 12

type CredentialRow = {
  metadata: string
  nonce: Uint8Array
  ciphertext: Uint8Array
  auth_tag: Uint8Array
  updated_at: string
}

export type StoredCredential = {
  secret: string
  metadata: Record<string, unknown>
  updatedAt: string
}

export class KalaStateStore {
  private database?: DatabaseSync
  private rootKey?: Buffer
  private maintenanceDepth = 0
  private verifiedSettingsSchema = false

  constructor(
    readonly stateRoot: string,
    private readonly options: {
      keyPath?: string
      legacyMemoDirectory?: string
      legacyCredentialDirectory?: string
      settingsSchemaMode?: 'bridge' | 'upgrade'
    } = {},
  ) {}

  readMemo(owner: string): MemoDocument {
    const db = this.open()
    const row = db.prepare('SELECT content, revision, updated_at FROM memos WHERE owner = ?').get(owner) as
      | { content: string; revision: number; updated_at: string }
      | undefined
    if (row) return { content: row.content, revision: row.revision, updatedAt: row.updated_at }
    const imported = this.importLegacyMemo(owner)
    return imported ?? { content: '', revision: 0, updatedAt: new Date(0).toISOString() }
  }

  writeMemo(owner: string, input: { content: string; expectedRevision?: number }): MemoDocument {
    if (Buffer.byteLength(input.content, 'utf8') > 10 * 1024 * 1024) throw new Error('memo_too_large')
    const db = this.open()
    db.exec('BEGIN IMMEDIATE')
    try {
      const current = this.readMemo(owner)
      if (input.expectedRevision !== undefined && current.revision !== input.expectedRevision) throw new Error('memo_revision_conflict')
      const next = { content: input.content, revision: current.revision + 1, updatedAt: new Date().toISOString() }
      db.prepare(`
        INSERT INTO memos (owner, content, revision, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(owner) DO UPDATE SET content = excluded.content, revision = excluded.revision, updated_at = excluded.updated_at
      `).run(owner, next.content, next.revision, next.updatedAt)
      db.exec('COMMIT')
      return next
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }

  getCredential(provider: string): StoredCredential | undefined {
    this.importLegacyCredential(provider)
    const row = this.open().prepare(`
      SELECT metadata, nonce, ciphertext, auth_tag, updated_at
      FROM credentials WHERE scope = 'unit' AND provider = ?
    `).get(provider) as CredentialRow | undefined
    if (!row) return undefined
    const key = this.loadRootKey(false)
    if (!key) throw new Error('credential master key is missing')
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(row.nonce))
    decipher.setAAD(credentialAad(provider))
    decipher.setAuthTag(Buffer.from(row.auth_tag))
    const secret = Buffer.concat([
      decipher.update(Buffer.from(row.ciphertext)),
      decipher.final(),
    ]).toString('utf8')
    return { secret, metadata: parseMetadata(row.metadata), updatedAt: row.updated_at }
  }

  credentialConfiguration(provider: string): { revision: string; value: StoredCredential | undefined } {
    return this.maintenanceTransaction(() => {
      const value = this.getCredential(provider)
      return { revision: this.settingsResourceRevision(credentialResource(provider)), value }
    })
  }

  setCredential(
    provider: string,
    secret: string,
    metadata: Record<string, unknown>,
    updatedAt = new Date().toISOString(),
    options: SettingsWriteOptions = {},
  ): void {
    this.mutateCredential(provider, options, () => this.writeCredential(provider, secret, metadata, updatedAt))
  }

  private writeCredential(provider: string, secret: string, metadata: Record<string, unknown>, updatedAt: string): void {
    const key = this.loadRootKey(true)
    if (!key) throw new Error('failed to create credential master key')
    const nonce = randomBytes(NONCE_BYTES)
    const cipher = createCipheriv('aes-256-gcm', key, nonce)
    cipher.setAAD(credentialAad(provider))
    const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()])
    this.open().prepare(`
      INSERT INTO credentials (scope, provider, metadata, nonce, ciphertext, auth_tag, updated_at)
      VALUES ('unit', ?, ?, ?, ?, ?, ?)
      ON CONFLICT(scope, provider) DO UPDATE SET
        metadata = excluded.metadata,
        nonce = excluded.nonce,
        ciphertext = excluded.ciphertext,
        auth_tag = excluded.auth_tag,
        updated_at = excluded.updated_at
    `).run(provider, JSON.stringify(metadata), nonce, ciphertext, cipher.getAuthTag(), updatedAt)
  }

  deleteCredential(provider: string, options: SettingsWriteOptions = {}): void {
    this.mutateCredential(provider, options, () => {
      this.open().prepare("DELETE FROM credentials WHERE scope = 'unit' AND provider = ?").run(provider)
    })
  }

  private mutateCredential(provider: string, options: SettingsWriteOptions, operation: () => void): void {
    this.maintenanceTransaction(() => {
      this.importLegacyCredential(provider)
      if (!this.settingsRevisionsAvailable()) {
        this.requireLegacySettingsWrite(options)
        operation()
        return
      }
      const resource = credentialResource(provider)
      const revision = this.settingsResourceRevision(resource)
      checkSettingsPrecondition(revision, options)
      const next = nextSettingsRevision(revision)
      operation()
      this.recordSettingsRevision(resource, next)
    })
  }

  maintenanceTransaction<T>(operation: () => T): T {
    const database = this.open()
    if (this.maintenanceDepth > 0) return operation()
    database.exec('BEGIN IMMEDIATE')
    this.maintenanceDepth += 1
    try {
      const value = operation()
      if (value && typeof value === 'object' && 'then' in value) throw new TypeError('SQLite maintenance operations must be synchronous')
      database.exec('COMMIT')
      return value
    } catch (error) {
      database.exec('ROLLBACK')
      throw error
    } finally {
      this.maintenanceDepth -= 1
    }
  }

  settingsResourceRevision(resource: { kind: string; id: string }): string {
    return this.maintenanceTransaction(() => {
      if (!this.settingsRevisionsAvailable()) throw Object.assign(new Error('configuration_revisions_unavailable'), { status: 503 })
      this.open().prepare(`INSERT OR IGNORE INTO settings_resource_versions
        (organization_id, resource_kind, resource_id, revision, updated_at) VALUES ('unit', ?, ?, 1, ?)`)
        .run(resource.kind, resource.id, new Date().toISOString())
      return this.settingsHighWater(resource)!
    })
  }

  settingsHighWater(resource: { kind: string; id: string }): string | undefined {
    if (!this.settingsRevisionsAvailable()) return undefined
    const row = this.open().prepare(`SELECT CAST(revision AS TEXT) AS revision FROM settings_resource_versions
      WHERE organization_id = 'unit' AND resource_kind = ? AND resource_id = ?`).get(resource.kind, resource.id) as { revision: string } | undefined
    return row?.revision
  }

  recordSettingsRevision(resource: { kind: string; id: string }, revision: string): void {
    if (this.maintenanceDepth === 0) throw new Error('settings revision requires the maintenance transaction')
    if (!this.settingsRevisionsAvailable()) throw Object.assign(new Error('configuration_revisions_unavailable'), { status: 503 })
    settingsRevision(revision)
    this.open().prepare(`INSERT INTO settings_resource_versions
      (organization_id, resource_kind, resource_id, revision, updated_at) VALUES ('unit', ?, ?, CAST(? AS INTEGER), ?)
      ON CONFLICT(organization_id, resource_kind, resource_id) DO UPDATE SET
        revision = excluded.revision, updated_at = excluded.updated_at`)
      .run(resource.kind, resource.id, revision, new Date().toISOString())
  }

  settingsContentHmac(content: string, create: boolean): string {
    const key = this.loadRootKey(create)
    if (!key) throw new Error('settings_integrity_key_missing')
    return createHmac('sha256', key).update('kala:settings-file:v1\0').update(content).digest('hex')
  }

  settingsRevisionsAvailable(): boolean {
    const database = this.open()
    const version = Number((database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version)
    if (version === 5) {
      if (!this.verifiedSettingsSchema) {
        migrateSqliteSettings(database, 5)
        this.verifiedSettingsSchema = true
      }
      return true
    }
    if (version !== 4 || this.verifiedSettingsSchema) throw new Error(`unsupported state database version: ${version}`)
    return false
  }

  requireLegacySettingsWrite(options: SettingsWriteOptions): void {
    if (options.expectedRevision !== undefined || options.writeProtocol === 'conditional-required') {
      throw Object.assign(new Error('configuration_revisions_unavailable'), { status: 503 })
    }
  }

  dagStore(): DagStore {
    return new DagStore(this.open())
  }

  close(): void {
    this.database?.close()
    this.database = undefined
    this.rootKey = undefined
    this.verifiedSettingsSchema = false
  }

  private open(): DatabaseSync {
    if (this.database) return this.database
    const settingsSchemaMode = this.options.settingsSchemaMode ?? process.env.KALA_SETTINGS_SCHEMA_MODE ?? 'upgrade'
    if (settingsSchemaMode !== 'bridge' && settingsSchemaMode !== 'upgrade') throw new Error('invalid_settings_schema_mode')
    mkdirSync(this.stateRoot, { recursive: true, mode: 0o700 })
    chmodSync(this.stateRoot, 0o700)
    const path = join(this.stateRoot, 'state.sqlite')
    const database = new DatabaseSync(path)
    const version = Number((database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version)
    if (![0, 1, 2, 3, 4, 5].includes(version)) {
      database.close()
      throw new Error(`unsupported state database version: ${version}`)
    }
    database.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS memos (
        owner TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK (revision >= 0),
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS credentials (
        scope TEXT NOT NULL,
        provider TEXT NOT NULL,
        metadata TEXT NOT NULL,
        nonce BLOB NOT NULL,
        ciphertext BLOB NOT NULL,
        auth_tag BLOB NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (scope, provider)
      );
      CREATE TABLE IF NOT EXISTS dag_runs (
        id TEXT PRIMARY KEY,
        parent_session_id TEXT NOT NULL,
        objective TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('planning', 'running', 'paused', 'completed', 'failed', 'cancelled')),
        graph_version INTEGER NOT NULL CHECK (graph_version >= 0),
        result_node_id TEXT,
        result TEXT,
        error TEXT,
        completed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS dag_nodes (
        id TEXT NOT NULL,
        run_id TEXT NOT NULL REFERENCES dag_runs(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        instructions TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'ready', 'running', 'waiting_user', 'succeeded', 'failed', 'cancelled', 'replaced')),
        depth INTEGER NOT NULL CHECK (depth >= 0),
        write_scopes TEXT NOT NULL,
        estimated_duration_minutes INTEGER CHECK (estimated_duration_minutes IS NULL OR estimated_duration_minutes >= 0),
        attempt INTEGER NOT NULL CHECK (attempt >= 0),
        child_session_id TEXT,
        progress TEXT,
        result TEXT,
        error TEXT,
        replaced_by TEXT,
        started_at TEXT,
        completed_at TEXT,
        tool_activity TEXT NOT NULL DEFAULT '[]',
        PRIMARY KEY (run_id, id)
      );
      CREATE TABLE IF NOT EXISTS dag_edges (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES dag_runs(id) ON DELETE CASCADE,
        source TEXT NOT NULL,
        target TEXT NOT NULL,
        UNIQUE (run_id, source, target),
        FOREIGN KEY (run_id, source) REFERENCES dag_nodes(run_id, id) ON DELETE CASCADE,
        FOREIGN KEY (run_id, target) REFERENCES dag_nodes(run_id, id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS dag_decisions (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES dag_runs(id) ON DELETE CASCADE,
        node_id TEXT NOT NULL,
        question TEXT NOT NULL,
        context TEXT NOT NULL,
        choices TEXT NOT NULL,
        allow_freeform INTEGER NOT NULL CHECK (allow_freeform IN (0, 1)),
        recommendation TEXT,
        reason TEXT,
        risk_level TEXT CHECK (risk_level IS NULL OR risk_level IN ('low', 'medium', 'high')),
        status TEXT NOT NULL CHECK (status IN ('pending', 'answered', 'cancelled')),
        answer TEXT,
        created_at TEXT NOT NULL,
        answered_at TEXT,
        FOREIGN KEY (run_id, node_id) REFERENCES dag_nodes(run_id, id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS dag_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL REFERENCES dag_runs(id) ON DELETE CASCADE,
        type TEXT NOT NULL CHECK (type IN ('run', 'node', 'decision', 'graph', 'lease')),
        message TEXT NOT NULL,
        node_id TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS dag_leases (
        run_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        owner TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        acquired_at TEXT NOT NULL,
        PRIMARY KEY (run_id, node_id),
        FOREIGN KEY (run_id, node_id) REFERENCES dag_nodes(run_id, id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS dag_operations (
        operation_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES dag_runs(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS dag_graph_versions (
        run_id TEXT NOT NULL REFERENCES dag_runs(id) ON DELETE CASCADE,
        version INTEGER NOT NULL CHECK (version > 0),
        result_node_id TEXT,
        nodes TEXT NOT NULL,
        edges TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (run_id, version)
      );
      CREATE TABLE IF NOT EXISTS dag_node_attempts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        attempt INTEGER NOT NULL CHECK (attempt > 0),
        worker_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'cancelled', 'interrupted', 'waiting_user', 'replaced')),
        started_at TEXT NOT NULL,
        completed_at TEXT,
        result TEXT,
        error TEXT,
        UNIQUE (run_id, node_id, attempt),
        FOREIGN KEY (run_id, node_id) REFERENCES dag_nodes(run_id, id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS dag_runs_parent_created_idx ON dag_runs(parent_session_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS dag_nodes_run_status_idx ON dag_nodes(run_id, status);
      CREATE INDEX IF NOT EXISTS dag_events_run_id_idx ON dag_events(run_id, id);
      CREATE INDEX IF NOT EXISTS dag_leases_expiry_idx ON dag_leases(expires_at);
      CREATE INDEX IF NOT EXISTS dag_attempts_run_node_idx ON dag_node_attempts(run_id, node_id, attempt);
    `)
    migrateDagSchema(database, version)
    backfillDagGraphVersions(database)
    try {
      if (version === 5 || settingsSchemaMode === 'upgrade') {
        migrateSqliteSettings(database, version)
        this.verifiedSettingsSchema = true
      } else {
        const unexpected = database.prepare("SELECT name FROM sqlite_master WHERE name IN ('settings_resource_versions', 'settings_schema_migrations')").all()
        if (unexpected.length) throw new Error('state_settings_migration_history_mismatch')
      }
    } catch (error) {
      database.close()
      throw error
    }
    chmodSync(path, 0o600)
    this.database = database
    return database
  }

  private loadRootKey(create: boolean): Buffer | undefined {
    if (this.rootKey) return this.rootKey
    const path = this.options.keyPath ?? process.env.KALA_STATE_MASTER_KEY_PATH ?? join(this.stateRoot, 'state-store.key')
    if (existsSync(path)) {
      const info = lstatSync(path)
      if (!info.isFile() || info.isSymbolicLink() || (process.platform !== 'win32' && ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()))) {
        throw new Error('credential master key must be an owner-only regular file')
      }
      const key = readFileSync(path)
      if (key.length !== KEY_BYTES) throw new Error('invalid credential master key length')
      this.rootKey = key
      return key
    }
    if (!create) return undefined
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    const key = randomBytes(KEY_BYTES)
    writeFileSync(path, key, { flag: 'wx', mode: 0o600 })
    chmodSync(path, 0o600)
    const descriptor = openSync(path, 'r')
    try { fsyncSync(descriptor) } finally { closeSync(descriptor) }
    if (process.platform !== 'win32') {
      const directory = openSync(dirname(path), 'r')
      try { fsyncSync(directory) } finally { closeSync(directory) }
    }
    this.rootKey = key
    return key
  }

  private importLegacyMemo(owner: string): MemoDocument | undefined {
    const directory = this.options.legacyMemoDirectory ?? join(this.stateRoot, 'memos')
    const path = join(directory, `${createHash('sha256').update(owner).digest('hex')}.json`)
    if (!existsSync(path)) return undefined
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<MemoDocument>
    if (typeof parsed.content !== 'string' || !Number.isInteger(parsed.revision) || (parsed.revision ?? -1) < 0 || typeof parsed.updatedAt !== 'string') {
      throw new Error(`invalid legacy memo: ${path}`)
    }
    const memo = parsed as MemoDocument
    this.open().prepare('INSERT OR IGNORE INTO memos (owner, content, revision, updated_at) VALUES (?, ?, ?, ?)')
      .run(owner, memo.content, memo.revision, memo.updatedAt)
    return memo
  }

  private importLegacyCredential(provider: string): void {
    const exists = this.open().prepare("SELECT 1 AS present FROM credentials WHERE scope = 'unit' AND provider = ?").get(provider)
    if (exists) return
    if (this.settingsHighWater(credentialResource(provider))) return
    const directory = this.options.legacyCredentialDirectory ?? join(this.stateRoot, 'credentials')
    if (provider === 'serper') this.importLegacyEncryptedRecord({
      provider,
      recordPath: join(directory, 'web-search.json'),
      keyPath: join(directory, 'master.key'),
      legacyAad: Buffer.from('agent-runlab:web-search-credential:v1:serper', 'utf8'),
      metadata(record) {
        return { version: 1, provider: 'serper', updatedAt: requiredString(record.updatedAt, 'updatedAt') }
      },
    })
    if (provider === 'azure_speech') this.importLegacyEncryptedRecord({
      provider,
      recordPath: join(directory, 'azure-speech.json'),
      keyPath: join(directory, 'speech-master.key'),
      legacyAad: Buffer.from('agent-runlab:azure-speech-credential:v1', 'utf8'),
      metadata(record) {
        return {
          version: 1,
          provider: 'azure',
          endpoint: requiredString(record.endpoint, 'endpoint'),
          region: requiredString(record.region, 'region'),
          enabled: record.enabled === true,
          mode: record.mode === 'after_recording' ? 'after_recording' : 'realtime',
          updatedAt: requiredString(record.updatedAt, 'updatedAt'),
        }
      },
    })
  }

  private importLegacyEncryptedRecord(input: {
    provider: string
    recordPath: string
    keyPath: string
    legacyAad: Buffer
    metadata(record: Record<string, unknown>): Record<string, unknown>
  }): void {
    if (!existsSync(input.recordPath)) return
    if (!existsSync(input.keyPath)) throw new Error(`legacy credential key is missing: ${input.keyPath}`)
    const key = readFileSync(input.keyPath)
    if (key.length !== KEY_BYTES) throw new Error('invalid legacy credential key length')
    const record = JSON.parse(readFileSync(input.recordPath, 'utf8')) as Record<string, unknown>
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(requiredString(record.iv, 'iv'), 'base64'))
    decipher.setAAD(input.legacyAad)
    decipher.setAuthTag(Buffer.from(requiredString(record.tag, 'tag'), 'base64'))
    const secret = Buffer.concat([
      decipher.update(Buffer.from(requiredString(record.ciphertext, 'ciphertext'), 'base64')),
      decipher.final(),
    ]).toString('utf8')
    const metadata = input.metadata(record)
    this.maintenanceTransaction(() => {
      if (this.settingsHighWater(credentialResource(input.provider))) return
      this.writeCredential(input.provider, secret, metadata, requiredString(record.updatedAt, 'updatedAt'))
      if (this.settingsRevisionsAvailable()) this.recordSettingsRevision(credentialResource(input.provider), '1')
    })
  }

}

function credentialResource(provider: string): { kind: string; id: string } {
  if (provider === 'serper') return { kind: 'search', id: 'serper' }
  if (provider === 'azure_speech') return { kind: 'speech', id: 'azure' }
  return { kind: 'credential', id: provider }
}

function migrateDagSchema(database: DatabaseSync, version: number): void {
  if (version === 0) {
    database.exec('PRAGMA user_version = 4')
    return
  }
  if (version === 1 || version === 2) {
    database.exec('PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE')
    try {
      const nodeColumns = database.prepare('PRAGMA table_info(dag_nodes)').all() as Array<{ name: string }>
      if (!nodeColumns.some((column) => column.name === 'estimated_duration_minutes')) {
        database.exec(`
          ALTER TABLE dag_nodes ADD COLUMN estimated_duration_minutes INTEGER
            CHECK (estimated_duration_minutes IS NULL OR estimated_duration_minutes >= 0)
        `)
      }
      const decisionColumns = database.prepare('PRAGMA table_info(dag_decisions)').all() as Array<{ name: string }>
      if (!decisionColumns.some((column) => column.name === 'reason')) {
        database.exec('ALTER TABLE dag_decisions ADD COLUMN reason TEXT')
      }
      if (!decisionColumns.some((column) => column.name === 'risk_level')) {
        database.exec(`
          ALTER TABLE dag_decisions ADD COLUMN risk_level TEXT
            CHECK (risk_level IS NULL OR risk_level IN ('low', 'medium', 'high'))
        `)
      }
      database.exec(`
        CREATE TABLE dag_runs_without_session_unique (
          id TEXT PRIMARY KEY,
          parent_session_id TEXT NOT NULL,
          objective TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('planning', 'running', 'paused', 'completed', 'failed', 'cancelled')),
          graph_version INTEGER NOT NULL CHECK (graph_version >= 0),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        INSERT INTO dag_runs_without_session_unique
          SELECT id, parent_session_id, objective, status, graph_version, created_at, updated_at FROM dag_runs;
        DROP TABLE dag_runs;
        ALTER TABLE dag_runs_without_session_unique RENAME TO dag_runs;
        CREATE INDEX dag_runs_parent_created_idx ON dag_runs(parent_session_id, created_at DESC);
      `)
      const violations = database.prepare('PRAGMA foreign_key_check').all()
      if (violations.length > 0) throw new Error('state database migration produced foreign key violations')
      database.exec('PRAGMA user_version = 3; COMMIT; PRAGMA foreign_keys = ON')
    } catch (error) {
      database.exec('ROLLBACK')
      database.exec('PRAGMA foreign_keys = ON')
      throw error
    }
  }
  const currentVersion = Number((database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version)
  if (currentVersion === 3) {
    database.exec('BEGIN IMMEDIATE')
    try {
      const runColumns = new Set((database.prepare('PRAGMA table_info(dag_runs)').all() as Array<{ name: string }>).map((column) => column.name))
      if (!runColumns.has('result_node_id')) database.exec('ALTER TABLE dag_runs ADD COLUMN result_node_id TEXT')
      if (!runColumns.has('result')) database.exec('ALTER TABLE dag_runs ADD COLUMN result TEXT')
      if (!runColumns.has('error')) database.exec('ALTER TABLE dag_runs ADD COLUMN error TEXT')
      if (!runColumns.has('completed_at')) database.exec('ALTER TABLE dag_runs ADD COLUMN completed_at TEXT')
      const nodeColumns = new Set((database.prepare('PRAGMA table_info(dag_nodes)').all() as Array<{ name: string }>).map((column) => column.name))
      if (!nodeColumns.has('tool_activity')) database.exec("ALTER TABLE dag_nodes ADD COLUMN tool_activity TEXT NOT NULL DEFAULT '[]'")
      const graphVersionColumns = new Set((database.prepare('PRAGMA table_info(dag_graph_versions)').all() as Array<{ name: string }>).map((column) => column.name))
      if (!graphVersionColumns.has('result_node_id')) database.exec('ALTER TABLE dag_graph_versions ADD COLUMN result_node_id TEXT')
      const runs = database.prepare('SELECT id, status, updated_at FROM dag_runs').all() as Array<{
        id: string
        status: string
        updated_at: string
      }>
      for (const run of runs) {
        const sink = database.prepare(`
          SELECT node.id, node.result, node.error
          FROM dag_nodes node
          WHERE node.run_id = ? AND node.status != 'replaced'
            AND NOT EXISTS (
              SELECT 1 FROM dag_edges edge WHERE edge.run_id = node.run_id AND edge.source = node.id
            )
          ORDER BY node.rowid DESC LIMIT 1
        `).get(run.id) as { id: string; result: string | null; error: string | null } | undefined
        if (!sink) continue
        database.prepare(`
          UPDATE dag_runs
          SET result_node_id = ?, result = ?, error = ?,
              completed_at = CASE WHEN status IN ('completed', 'failed', 'cancelled') THEN ? ELSE NULL END
          WHERE id = ?
        `).run(sink.id, run.status === 'completed' ? sink.result : null, run.status === 'completed' ? null : sink.error, run.updated_at, run.id)
        const graphVersions = database.prepare(`
          SELECT version, nodes, edges
          FROM dag_graph_versions
          WHERE run_id = ? AND result_node_id IS NULL
          ORDER BY version
        `).all(run.id) as Array<{ version: number; nodes: string; edges: string }>
        for (const graphVersion of graphVersions) {
          const resultNodeId = legacyGraphResultNodeId(graphVersion.nodes, graphVersion.edges)
          database.prepare(`
            UPDATE dag_graph_versions
            SET result_node_id = ?
            WHERE run_id = ? AND version = ?
          `).run(resultNodeId, run.id, graphVersion.version)
        }
      }
      database.exec('PRAGMA user_version = 4; COMMIT')
    } catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
  }
}

function legacyGraphResultNodeId(nodesJson: string, edgesJson: string): string {
  const nodes = JSON.parse(nodesJson) as unknown
  const edges = JSON.parse(edgesJson) as unknown
  if (!Array.isArray(nodes) || !Array.isArray(edges)) throw new Error('legacy DAG graph snapshot is malformed')
  const nodeIds = nodes.flatMap((node) => (
    node && typeof node === 'object' && typeof (node as { id?: unknown }).id === 'string'
      ? [(node as { id: string }).id]
      : []
  ))
  const sources = new Set(edges.flatMap((edge) => (
    edge && typeof edge === 'object' && typeof (edge as { source?: unknown }).source === 'string'
      ? [(edge as { source: string }).source]
      : []
  )))
  const resultNodeId = nodeIds.filter((id) => !sources.has(id)).at(-1)
  if (!resultNodeId) throw new Error('legacy DAG graph snapshot has no result node')
  return resultNodeId
}

function backfillDagGraphVersions(database: DatabaseSync): void {
  const runs = database.prepare(`
    SELECT id, graph_version AS graphVersion, result_node_id AS resultNodeId, updated_at AS updatedAt
    FROM dag_runs
    WHERE graph_version > 0
      AND NOT EXISTS (
        SELECT 1 FROM dag_graph_versions version
        WHERE version.run_id = dag_runs.id AND version.version = dag_runs.graph_version
      )
  `).all() as Array<{ id: string; graphVersion: number; resultNodeId: string | null; updatedAt: string }>
  const nodesStatement = database.prepare(`
    SELECT id, title, instructions, depth, write_scopes AS writeScopes,
           estimated_duration_minutes AS estimatedDurationMinutes
    FROM dag_nodes WHERE run_id = ? AND status != 'replaced' ORDER BY rowid
  `)
  const edgesStatement = database.prepare(`
    SELECT source, target FROM dag_edges WHERE run_id = ? ORDER BY rowid
  `)
  const insert = database.prepare(`
    INSERT INTO dag_graph_versions (run_id, version, result_node_id, nodes, edges, created_at) VALUES (?, ?, ?, ?, ?, ?)
  `)
  for (const run of runs) {
    const rows = nodesStatement.all(run.id) as Array<{
      id: string
      title: string
      instructions: string
      depth: number
      writeScopes: string
      estimatedDurationMinutes: number | null
    }>
    const nodes = rows.map((node) => ({
      id: node.id,
      title: node.title,
      instructions: node.instructions,
      depth: node.depth,
      writeScopes: JSON.parse(node.writeScopes) as unknown,
      ...(node.estimatedDurationMinutes === null ? {} : { estimatedDurationMinutes: node.estimatedDurationMinutes }),
    }))
    const resultNodeId = run.resultNodeId ?? nodes.at(-1)?.id
    if (!resultNodeId) continue
    insert.run(run.id, run.graphVersion, resultNodeId, JSON.stringify(nodes), JSON.stringify(edgesStatement.all(run.id)), run.updatedAt)
  }
}

function credentialAad(provider: string): Buffer {
  return Buffer.from(`kala:credential-vault:v1:unit:${provider}`, 'utf8')
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`invalid legacy credential ${name}`)
  return value
}

function parseMetadata(value: string): Record<string, unknown> {
  const parsed = JSON.parse(value) as unknown
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid credential metadata')
  return parsed as Record<string, unknown>
}
