import { createHash } from 'node:crypto'
import type { IncomingMessage } from 'node:http'

import type { DashboardActor } from '../auth-control.js'
import { SettingsConcurrencyError, settingsRevision, type SettingsWriteOptions, type SettingsWriteProtocol } from '../settings-concurrency.js'

export type RevisionedSettingsKind = 'models' | 'agent' | 'search' | 'speech'

export function settingsWriteProtocolFromEnvironment(value = process.env.KALA_SETTINGS_WRITE_PROTOCOL): SettingsWriteProtocol {
  if (value === undefined || value === 'legacy-compatible') return 'legacy-compatible'
  if (value === 'conditional-required') return value
  throw new Error('invalid settingsWriteProtocol; expected legacy-compatible or conditional-required')
}

export function configurationEtag(request: IncomingMessage, resource: RevisionedSettingsKind, actor: DashboardActor, revision: string): string {
  settingsRevision(revision)
  const identity = actor.kind === 'ingress' ? actor.organizationId : 'local'
  const digest = createHash('sha256').update(JSON.stringify([
    'kala-settings-v1', request.headers.host?.toLowerCase(), identity, resource, revision,
  ])).digest('base64url')
  return `"${digest}"`
}

export async function configurationWriteOptions(
  request: IncomingMessage,
  resource: RevisionedSettingsKind,
  actor: DashboardActor,
  protocol: SettingsWriteProtocol,
  readRevision: (() => Promise<string | undefined> | string | undefined) | undefined,
): Promise<SettingsWriteOptions> {
  const header = request.headers['if-match']
  if (header === undefined) {
    if (protocol === 'conditional-required') throw new SettingsConcurrencyError('client_upgrade_required', 428)
    return { writeProtocol: protocol }
  }
  if (!readRevision) throw Object.assign(new Error('configuration_revisions_unavailable'), { status: 503 })
  const revision = await readRevision()
  if (!revision) throw Object.assign(new Error('configuration_revisions_unavailable'), { status: 503 })
  if (typeof header !== 'string' || header !== configurationEtag(request, resource, actor, revision)) {
    throw new SettingsConcurrencyError('configuration_conflict', 412)
  }
  return { expectedRevision: revision, writeProtocol: protocol }
}
