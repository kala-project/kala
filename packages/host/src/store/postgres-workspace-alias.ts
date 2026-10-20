import type { HotStateDatabase } from '../tenant-runtime/postgres-hot-state.js'
import { privateCloudStorageTable } from './postgres-private-cloud-storage.js'
import type { WorkspaceAliasStorage } from './workspace-alias.js'

type AliasRow = Record<string, unknown> & { workspace_id: string; workspace_name: string }

/** PostgreSQL-backed alias cache scoped by an organization id from trusted runtime authority. */
export class PostgresWorkspaceAliasStore implements WorkspaceAliasStorage {
  readonly #organizationId: string
  readonly #table: string
  #aliases = new Map<string, string>()

  constructor(
    readonly database: HotStateDatabase,
    organizationId: string,
    options: { schema?: string } = {},
  ) {
    if (!organizationId) throw new TypeError('organizationId must be a non-empty trusted identifier')
    this.#organizationId = organizationId
    this.#table = privateCloudStorageTable(options.schema, 'workspace_aliases')
  }

  async load(): Promise<void> {
    const result = await this.database.query<AliasRow>(`SELECT workspace_id, workspace_name
      FROM ${this.#table} WHERE organization_id = $1`, [this.#organizationId])
    this.#aliases = new Map(result.rows.map((row) => [row.workspace_id, row.workspace_name]))
  }

  get(workspaceId: string): string | undefined {
    return this.#aliases.get(workspaceId)
  }

  apply<T extends { workspaceId: string; workspaceName: string }>(item: T): T {
    const alias = this.#aliases.get(item.workspaceId)
    return alias ? { ...item, workspaceName: alias } : item
  }

  async rename(workspaceId: string, workspaceName: string): Promise<string> {
    const cleanId = workspaceId.trim()
    const cleanName = workspaceName.trim()
    if (!cleanId) throw new Error('workspaceId is required')
    if (!cleanName) throw new Error('workspace name is required')
    await this.database.query(`INSERT INTO ${this.#table}
        (organization_id, workspace_id, workspace_name, updated_at)
      VALUES ($1, $2, $3, clock_timestamp())
      ON CONFLICT (organization_id, workspace_id) DO UPDATE SET
        workspace_name = EXCLUDED.workspace_name,
        updated_at = EXCLUDED.updated_at`, [this.#organizationId, cleanId, cleanName])
    // Only expose the new alias after PostgreSQL has acknowledged the commit.
    this.#aliases.set(cleanId, cleanName)
    return cleanName
  }
}
