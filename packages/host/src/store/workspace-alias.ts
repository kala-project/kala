import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

type AliasFile = {
  workspaces?: Record<string, string>
}

export interface WorkspaceAliasStorage {
  load(): Promise<void>
  get(workspaceId: string): string | undefined
  apply<T extends { workspaceId: string; workspaceName: string }>(item: T): T
  rename(workspaceId: string, workspaceName: string): Promise<string>
}

export class WorkspaceAliasStore implements WorkspaceAliasStorage {
  private aliases = new Map<string, string>()
  private loaded = false

  constructor(private readonly path: string) {}

  async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    try {
      const raw = await readFile(this.path, 'utf8')
      const parsed = JSON.parse(raw) as AliasFile
      for (const [workspaceId, name] of Object.entries(parsed.workspaces ?? {})) {
        const cleanId = workspaceId.trim()
        const cleanName = name.trim()
        if (cleanId.length > 0 && cleanName.length > 0) {
          this.aliases.set(cleanId, cleanName)
        }
      }
    } catch {
      // Missing or malformed alias files should not prevent the host from booting.
      this.aliases.clear()
    }
  }

  get(workspaceId: string): string | undefined {
    return this.aliases.get(workspaceId)
  }

  apply<T extends { workspaceId: string; workspaceName: string }>(item: T): T {
    const alias = this.aliases.get(item.workspaceId)
    return alias ? { ...item, workspaceName: alias } : item
  }

  async rename(workspaceId: string, workspaceName: string): Promise<string> {
    const cleanId = workspaceId.trim()
    const cleanName = workspaceName.trim()
    if (cleanId.length === 0) throw new Error('workspaceId is required')
    if (cleanName.length === 0) throw new Error('workspace name is required')
    this.aliases.set(cleanId, cleanName)
    await mkdir(dirname(this.path), { recursive: true })
    const sorted = [...this.aliases.entries()].sort(([a], [b]) => a.localeCompare(b))
    await writeFile(
      this.path,
      `${JSON.stringify({ workspaces: Object.fromEntries(sorted) }, null, 2)}\n`,
      'utf8',
    )
    return cleanName
  }
}
