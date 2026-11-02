import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, rmdirSync, writeSync } from 'node:fs'
import { join } from 'node:path'

const MARKER = 'portable-installation.json'
const SCHEMA_VERSION = 1

/**
 * Existing state roots (including roots with state.sqlite) are legacy unless
 * explicitly marked. Only a previously nonexistent root can be claimed for
 * the new SQLite authority; there is deliberately no implicit JSONL import.
 */
export function selectPortableInstallation(stateRoot: string, initializeFresh: boolean): 'legacy' | 'sqlite' {
  const markerPath = join(stateRoot, MARKER)
  if (existsSync(markerPath)) {
    const parsed: unknown = JSON.parse(readFileSync(markerPath, 'utf8'))
    if (!parsed || typeof parsed !== 'object' || !('schemaVersion' in parsed)
      || parsed.schemaVersion !== SCHEMA_VERSION || !('authority' in parsed) || parsed.authority !== 'sqlite') {
      throw new Error('Unrecognized Portable installation marker; refusing to select a storage authority')
    }
    return 'sqlite'
  }
  if (!initializeFresh) return 'legacy'
  if (existsSync(stateRoot)) {
    throw new Error('Fresh Portable SQLite installation requires a previously nonexistent state root; existing data will not be migrated')
  }
  mkdirSync(stateRoot, { mode: 0o700 })
  try {
    const fd = openSync(markerPath, 'wx', 0o600)
    try {
      writeSync(fd, `${JSON.stringify({ schemaVersion: SCHEMA_VERSION, authority: 'sqlite' })}\n`)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    return 'sqlite'
  } catch (error) {
    // Only the newly created empty directory is ours; never clean an existing installation.
    try { rmdirSync(stateRoot) } catch { /* keep an uncertain root intact */ }
    throw error
  }
}
