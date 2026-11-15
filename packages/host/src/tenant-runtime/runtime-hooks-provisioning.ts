import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { settingsRevision } from '../settings-concurrency.js'
import { atomicPrivateSettingsFile } from '../store/settings-file.js'
import { parseHookConfigToml } from '../runtime-config.js'

type Entry = { unitId: string; organizationId: string; configFile: string; contentSha256: string }

/** The mounted manifest and its immutable source files, not a disposable Unit tree, own reconstruction. */
export function provisionRuntimeHooks(options: {
  unitRoot: string
  unitId: string
  organizationId: string
  manifestPath: string
}): { revision: string } {
  const raw: unknown = JSON.parse(readProtectedFile(options.manifestPath, 2 * 1024 * 1024))
  if (!isRecord(raw) || !exactKeys(raw, ['schemaVersion', 'revision', 'units'])
    || raw.schemaVersion !== 1 || typeof raw.revision !== 'string' || !Array.isArray(raw.units)
    || raw.units.length > 10_000) throw new Error('invalid_runtime_hooks_manifest')
  settingsRevision(raw.revision)
  const seen = new Set<string>()
  for (const candidate of raw.units) {
    if (!isRecord(candidate) || !exactKeys(candidate, ['unitId', 'organizationId', 'configFile', 'contentSha256'])
      || typeof candidate.unitId !== 'string' || !/^[0-9A-Za-z][0-9A-Za-z_-]{0,127}$/u.test(candidate.unitId)
      || typeof candidate.organizationId !== 'string' || !candidate.organizationId.trim()
      || candidate.organizationId !== candidate.organizationId.trim()
      || typeof candidate.configFile !== 'string' || !isAbsolute(candidate.configFile)
      || typeof candidate.contentSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(candidate.contentSha256)
      || seen.has(candidate.unitId)) throw new Error('invalid_runtime_hooks_manifest')
    seen.add(candidate.unitId)
  }
  const entry = (raw.units as Entry[]).find(candidate => candidate.unitId === options.unitId)
  if (entry && entry.organizationId !== options.organizationId) throw new Error('runtime_hooks_organization_mismatch')
  // Absence is explicitly no Hooks, not fallback to a former local configuration.
  const contents = entry ? readProtectedFile(entry.configFile, 1024 * 1024) : ''
  if (entry && createHash('sha256').update(contents).digest('hex') !== entry.contentSha256) {
    throw new Error('runtime_hooks_source_changed')
  }
  const hooks = parseHookConfigToml(contents)
  if ((contents.match(/^\s*\[\[hooks\]\]\s*(?:#.*)?$/gmu)?.length ?? 0) !== hooks.length) {
    throw new Error('invalid_runtime_hooks_configuration')
  }
  atomicPrivateSettingsFile(join(options.unitRoot, 'config.toml'), contents)
  return { revision: raw.revision }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
}

function readProtectedFile(path: string, limit: number): string {
  if (!isAbsolute(path)) throw new Error('runtime_hooks_source_requires_absolute_path')
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const info = fstatSync(descriptor)
    if (!info.isFile() || info.size > limit || process.platform !== 'win32'
      && ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.())) {
      throw new Error('runtime_hooks_source_must_be_owner_only')
    }
    const contents = readFileSync(descriptor, 'utf8')
    if (Buffer.byteLength(contents) > limit) throw new Error('runtime_hooks_source_too_large')
    return contents
  } finally { closeSync(descriptor) }
}
