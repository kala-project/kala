/**
 * Workspace identity. A workspace = one local executor profile.
 *
 * Identity is a ULID persisted to `~/.kala/workspace-id` on first
 * launch, then read verbatim on every subsequent launch. Sessions bind to
 * this ID in their JSONL header — renaming the workspace (via `--name`)
 * changes only the display label; routing stays intact.
 *
 * We deliberately do NOT use `os.hostname()` or `/etc/machine-id` as the
 * primary ID: the former is user-mutable, the latter is per-machine (not
 * per-user/profile) so two users or profiles on the same host would share a workspace.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { ulid } from 'ulid'

export const WORKSPACE_ID_ENV = 'KALA_WORKSPACE_ID_FILE'
export const EXECUTOR_PROFILE_ENV = 'KALA_EXECUTOR_PROFILE'

export function normalizeExecutorProfile(profile: string | undefined): string | undefined {
  const value = profile?.trim()
  if (!value || value === 'default') return undefined
  if (value === '.' || value === '..' || !/^[A-Za-z0-9._-]{1,64}$/.test(value)) {
    throw new Error(
      `Invalid executor profile ${JSON.stringify(profile)}. Use letters, numbers, dot, underscore, or dash.`,
    )
  }
  return value
}

export function executorProfileDir(profile: string | undefined): string {
  const normalized = normalizeExecutorProfile(profile)
  return normalized
    ? join(homedir(), '.kala', 'profiles', normalized)
    : join(homedir(), '.kala')
}

export function workspaceIdPath(profile?: string): string {
  const override = process.env[WORKSPACE_ID_ENV]
  if (override && override.length > 0) return override
  return join(executorProfileDir(profile ?? process.env[EXECUTOR_PROFILE_ENV]), 'workspace-id')
}

/**
 * Load the workspace id, minting one on first run. Idempotent: multiple
 * calls in the same process return the same id, and multiple executor
 * processes using the same profile all resolve to the same file.
 *
 * Throws if the file exists but is not a well-formed ULID — a corrupted
 * id would silently detach this machine's sessions on next start, which
 * is worse than failing loudly.
 */
export function loadOrCreateWorkspaceId(pathOverride?: string, profile?: string): string {
  const path = pathOverride ?? workspaceIdPath(profile)
  if (existsSync(path)) {
    const raw = readFileSync(path, 'utf8').trim()
    if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(raw)) {
      throw new Error(
        `Invalid workspace id at ${path}: ${JSON.stringify(raw)}. Delete the file to regenerate (WARNING: existing sessions bound to the old id will detach).`,
      )
    }
    return raw
  }
  const id = ulid()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, id + '\n', { encoding: 'utf8', mode: 0o600 })
  return id
}

export function resolveWorkspaceId(configuredId: string | undefined, profile: string | undefined): string {
  return configuredId ?? loadOrCreateWorkspaceId(undefined, profile)
}
