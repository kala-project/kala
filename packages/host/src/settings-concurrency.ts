export type SettingsWriteProtocol = 'legacy-compatible' | 'conditional-required'

export type SettingsWriteOptions = {
  expectedRevision?: string
  writeProtocol?: SettingsWriteProtocol
}

export class SettingsConcurrencyError extends Error {
  constructor(
    readonly code: 'configuration_conflict' | 'client_upgrade_required' | 'invalid_configuration_revision',
    readonly status: 400 | 412 | 428,
  ) {
    super(code)
    this.name = 'SettingsConcurrencyError'
  }
}

export function settingsRevision(value: string): bigint {
  if (!/^[1-9][0-9]{0,18}$/u.test(value) || BigInt(value) > 9223372036854775807n) {
    throw new SettingsConcurrencyError('invalid_configuration_revision', 400)
  }
  return BigInt(value)
}

export function checkSettingsPrecondition(revision: string, options: SettingsWriteOptions): void {
  settingsRevision(revision)
  if (options.expectedRevision !== undefined) {
    settingsRevision(options.expectedRevision)
    if (revision !== options.expectedRevision) throw new SettingsConcurrencyError('configuration_conflict', 412)
  } else if (options.writeProtocol === 'conditional-required') {
    throw new SettingsConcurrencyError('client_upgrade_required', 428)
  }
}

export function nextSettingsRevision(revision: string): string {
  const next = (settingsRevision(revision) + 1n).toString()
  settingsRevision(next)
  return next
}
