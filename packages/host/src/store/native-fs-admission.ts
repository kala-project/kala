import type { HotStateSqlExecutor } from '../tenant-runtime/postgres-hot-state.js'

export function nativeFsAdmissionSchemaStatements(schema: string): readonly string[] {
  return [`CREATE TABLE IF NOT EXISTS ${schema}.tenant_session_native_fs_admission (
    tenant_id TEXT NOT NULL, session_id TEXT NOT NULL,
    backend TEXT NOT NULL CHECK (backend IN ('text', 'posix-import', 'posix')),
    import_id TEXT, manifest_sha256 TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (tenant_id, session_id),
    CHECK (backend <> 'posix-import' OR import_id IS NOT NULL),
    CHECK (manifest_sha256 IS NULL OR manifest_sha256 ~ '^[0-9a-f]{64}$')
  )`]
}

export type NativeFsAdmission = {
  backend: 'text' | 'posix-import' | 'posix'
  importId: string | null
  manifestSha256: string | null
}

/** Both native adapters take this lock before any native rows are read or written. */
export async function lockNativeFsAdmission(
  sql: HotStateSqlExecutor, table: string, tenantId: string, sessionId: string,
): Promise<NativeFsAdmission> {
  await sql.query(`INSERT INTO ${table} (tenant_id,session_id,backend)
    VALUES ($1,$2,'text') ON CONFLICT DO NOTHING`, [tenantId, sessionId])
  const { rows } = await sql.query(`SELECT backend,import_id,manifest_sha256 FROM ${table}
    WHERE tenant_id=$1 AND session_id=$2 FOR UPDATE`, [tenantId, sessionId])
  const row = rows[0]
  if (!row || (row.backend !== 'text' && row.backend !== 'posix-import' && row.backend !== 'posix')) {
    throw new Error('Invalid native filesystem admission state')
  }
  return { backend: row.backend,
    importId: typeof row.import_id === 'string' ? row.import_id : null,
    manifestSha256: typeof row.manifest_sha256 === 'string' ? row.manifest_sha256 : null }
}

export function assertNativeFsAdmission(
  admission: NativeFsAdmission, backend: 'text' | 'posix', importId?: string,
): void {
  const allowed = backend === 'text' ? admission.backend === 'text'
    : importId === undefined ? admission.backend === 'posix'
      : admission.backend === 'posix-import' && admission.importId === importId
  if (!allowed) throw new Error(`Native filesystem ${backend} access is blocked by ${admission.backend} admission`)
}
