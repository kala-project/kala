import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'

import { agentSettingsSnapshot, defaultAgentRuntimeSettings, updateAgentRuntimeSettings, writeAgentRuntimeSettings } from '../runtime-config.js'
import { KalaStateStore } from './state-store.js'
import { SettingsFile } from './settings-file.js'

const fixtures: Array<{ root: string; state: KalaStateStore }> = []
afterEach(() => {
  for (const { root, state } of fixtures.splice(0)) {
    state.close()
    rmSync(root, { recursive: true, force: true })
  }
})

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'kala-settings-files-'))
  const state = new KalaStateStore(join(root, 'state'))
  const path = join(root, 'models.json')
  const validate = (input: unknown): { label: string } => {
    if (!input || typeof input !== 'object' || !('label' in input) || typeof input.label !== 'string') throw new Error('invalid fixture settings')
    return { label: input.label }
  }
  writeFileSync(path, JSON.stringify({ label: 'initial' }))
  const file = new SettingsFile(path, state, { kind: 'models', id: 'catalog' }, validate)
  fixtures.push({ root, state })
  return { root, state, path, file }
}

describe('Portable managed JSON authority', () => {
  it('runs a non-expanding SQLite4 bridge, preserves existing data during upgrade, then performs write-aware rollback on SQLite5', () => {
    const root = mkdtempSync(join(tmpdir(), 'kala-settings-bridge-'))
    const stateRoot = join(root, 'state')
    const bridge = new KalaStateStore(stateRoot, { settingsSchemaMode: 'bridge' })
    fixtures.push({ root, state: bridge })
    const path = join(root, 'agent.json')
    writeFileSync(path, JSON.stringify(defaultAgentRuntimeSettings()), { mode: 0o600 })
    expect(bridge.settingsRevisionsAvailable()).toBe(false)
    bridge.setCredential('serper', 'baseline-fixture-only', { source: 'baseline' })
    updateAgentRuntimeSettings(path, current => ({ ...current, selectedSlotId: 'slot-2' }), bridge)
    expect(JSON.parse(readFileSync(path, 'utf8'))._kalaSettings).toBeUndefined()
    expect(() => bridge.setCredential('serper', 'rejected-fixture-only', {}, undefined, { expectedRevision: '1' }))
      .toThrow('configuration_revisions_unavailable')
    const database = new DatabaseSync(join(stateRoot, 'state.sqlite'))
    const encryptedBefore = database.prepare("SELECT hex(ciphertext) AS ciphertext FROM credentials WHERE provider = 'serper'").get()
    expect(database.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 4 })
    database.close()

    const upgraded = new KalaStateStore(stateRoot, { settingsSchemaMode: 'upgrade' })
    try {
      expect(upgraded.settingsRevisionsAvailable()).toBe(true)
      const after = new DatabaseSync(join(stateRoot, 'state.sqlite'))
      expect(after.prepare("SELECT hex(ciphertext) AS ciphertext FROM credentials WHERE provider = 'serper'").get()).toEqual(encryptedBefore)
      after.close()
      expect(upgraded.credentialConfiguration('serper')).toMatchObject({ revision: '1', value: { secret: 'baseline-fixture-only' } })
      expect(agentSettingsSnapshot(path, upgraded)).toMatchObject({ revision: '1', value: { selectedSlotId: 'slot-2' } })

      // The still-running pre-expansion bridge recognizes the reviewed expansion.
      bridge.setCredential('serper', 'bridge-fixture-only', { source: 'bridge' })
      updateAgentRuntimeSettings(path, current => ({ ...current, computerUseEnabled: true }), bridge)
      expect(upgraded.credentialConfiguration('serper')).toMatchObject({ revision: '2', value: { secret: 'bridge-fixture-only' } })
      expect(agentSettingsSnapshot(path, upgraded)).toMatchObject({ revision: '2', value: { computerUseEnabled: true, selectedSlotId: 'slot-2' } })
      expect(() => updateAgentRuntimeSettings(path, current => ({ ...current, selectedSlotId: 'slot-3' }), upgraded, { expectedRevision: '1' }))
        .toThrow('configuration_conflict')
      upgraded.setCredential('serper', 'expanded-fixture-only', { source: 'expanded' }, undefined, { expectedRevision: '2' })
      bridge.close()
      const rollback = new KalaStateStore(stateRoot, { settingsSchemaMode: 'bridge' })
      try {
        expect(rollback.credentialConfiguration('serper')).toMatchObject({ revision: '3', value: { secret: 'expanded-fixture-only' } })
        updateAgentRuntimeSettings(path, current => ({ ...current, desktopPreviewEnabled: true }), rollback, { expectedRevision: '2' })
        expect(agentSettingsSnapshot(path, upgraded)).toMatchObject({ revision: '3', value: {
          selectedSlotId: 'slot-2', computerUseEnabled: true, desktopPreviewEnabled: true,
        } })
        expect(JSON.parse(readFileSync(path, 'utf8'))._kalaSettings).toMatchObject({ formatVersion: 1, revision: '3' })
      } finally { rollback.close() }
    } finally { upgraded.close() }
  })

  it('initializes legacy content once, preserves revisions through compatibility writers and rejects stale/required writes', () => {
    const { file, path } = fixture()
    expect(file.read()).toEqual({ revision: '1', value: { label: 'initial' } })
    expect(file.update(() => ({ label: 'conditional' }), { expectedRevision: '1' }).revision).toBe('2')
    expect(file.update(() => ({ label: 'legacy' })).revision).toBe('3')
    expect(() => file.update(() => ({ label: 'stale' }), { expectedRevision: '2' })).toThrow('configuration_conflict')
    expect(() => file.update(() => ({ label: 'old client' }), { writeProtocol: 'conditional-required' })).toThrow('client_upgrade_required')
    expect(file.read()).toEqual({ revision: '3', value: { label: 'legacy' } })
    expect(JSON.parse(readFileSync(path, 'utf8'))._kalaSettings).toMatchObject({ formatVersion: 1, revision: '3' })
  })

  it('uses the same prompt/desktop revision and keeps unrelated fields under a locked update', () => {
    const { root, state } = fixture()
    const path = join(root, 'agent.json')
    writeFileSync(path, JSON.stringify(defaultAgentRuntimeSettings()))
    const prompt = updateAgentRuntimeSettings(path, (current) => ({ ...current, selectedSlotId: 'slot-2' }), state, { expectedRevision: '1' })
    expect(prompt.revision).toBe('2')
    expect(() => updateAgentRuntimeSettings(path, (current) => ({ ...current, computerUseEnabled: true }), state, {
      expectedRevision: '1',
    })).toThrow('configuration_conflict')
    const desktop = updateAgentRuntimeSettings(path, (current) => ({ ...current, computerUseEnabled: true }), state, {
      expectedRevision: '2',
    })
    expect(desktop.value).toMatchObject({ selectedSlotId: 'slot-2', computerUseEnabled: true })
    writeAgentRuntimeSettings(path, desktop.value!, state)
    expect(JSON.parse(readFileSync(path, 'utf8'))._kalaSettings.revision).toBe('4')
  })

  it('fails closed on content/revision edits and removed metadata, then imports explicitly above its high-water mark', () => {
    const { file, path } = fixture()
    file.read()
    const original = JSON.parse(readFileSync(path, 'utf8'))
    writeFileSync(path, JSON.stringify({ ...original, label: 'external edit' }))
    expect(() => file.read()).toThrow('settings_content_integrity_failed')
    writeFileSync(path, JSON.stringify({ ...original, _kalaSettings: { ...original._kalaSettings, revision: '99' } }))
    expect(() => file.read()).toThrow('settings_content_integrity_failed')
    writeFileSync(path, JSON.stringify({ label: 'removed metadata' }))
    expect(() => file.read()).toThrow('settings_metadata_missing_after_migration')
    expect(file.import({ label: 'reviewed import' })).toEqual({ revision: '2', value: { label: 'reviewed import' } })
    unlinkSync(path)
    expect(() => file.read()).toThrow('settings_file_missing_after_migration')
    expect(file.import({ label: 'repaired' }).revision).toBe('3')
  })

  it('recovers the durable JSON revision after a real process exits between rename and SQLite commit', () => {
    const { root, state, path, file } = fixture()
    file.read()
    const modulePath = fileURLToPath(new URL('./state-store.ts', import.meta.url))
    const fileModulePath = fileURLToPath(new URL('./settings-file.ts', import.meta.url))
    const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
      const { KalaStateStore } = await import(${JSON.stringify(modulePath)});
      const { SettingsFile } = await import(${JSON.stringify(fileModulePath)});
      const state = new KalaStateStore(${JSON.stringify(join(root, 'state'))});
      const file = new SettingsFile(${JSON.stringify(path)}, state, {kind:'models',id:'catalog'}, value => value);
      state.recordSettingsRevision = () => process.exit(74);
      file.update(() => ({label:'durable before crash'}), {expectedRevision:'1'});
    `], { cwd: fileURLToPath(new URL('../../', import.meta.url)), encoding: 'utf8' })
    expect(child.status, child.stderr).toBe(74)
    expect(file.read()).toEqual({ revision: '2', value: { label: 'durable before crash' } })
    expect(state.settingsHighWater({ kind: 'models', id: 'catalog' })).toBe('2')
    expect(file.update(() => ({ label: 'next' }), { expectedRevision: '2' }).revision).toBe('3')
  })

  it('serializes competing real-process writers and allows only one conditional commit', async () => {
    const { root, path, file } = fixture()
    file.read()
    const modulePath = fileURLToPath(new URL('./state-store.ts', import.meta.url))
    const fileModulePath = fileURLToPath(new URL('./settings-file.ts', import.meta.url))
    const workers = ['first', 'second'].map((label) => {
      const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
        const { KalaStateStore } = await import(${JSON.stringify(modulePath)});
        const { SettingsFile } = await import(${JSON.stringify(fileModulePath)});
        const state = new KalaStateStore(${JSON.stringify(join(root, 'state'))});
        const file = new SettingsFile(${JSON.stringify(path)}, state, {kind:'models',id:'catalog'}, value => value);
        const snapshot = file.read();
        process.once('message', () => {
          try { process.stdout.write(file.update(() => ({label:${JSON.stringify(label)}}), {expectedRevision:snapshot.revision}).revision); }
          catch (error) { process.stdout.write(error.message); }
          finally { state.close(); process.disconnect(); }
        });
        process.send('ready');
      `], { cwd: fileURLToPath(new URL('../../', import.meta.url)), stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
      let output = ''
      let errors = ''
      child.stdout!.on('data', (data) => { output += data.toString() })
      child.stderr!.on('data', (data) => { errors += data.toString() })
      const ready = new Promise<void>((resolve, reject) => {
        child.once('message', () => resolve())
        child.once('error', reject)
        child.once('exit', (code) => { if (code !== 0) reject(new Error(errors)) })
      })
      const done = new Promise<string>((resolve, reject) => {
        child.once('error', reject)
        child.once('exit', (code) => code === 0 ? resolve(output) : reject(new Error(errors)))
      })
      return { child, ready, done }
    })
    try {
      await Promise.all(workers.map((worker) => worker.ready))
      for (const { child } of workers) child.send('commit')
      expect((await Promise.all(workers.map((worker) => worker.done))).sort()).toEqual(['2', 'configuration_conflict'])
      expect(file.read().revision).toBe('2')
    } finally {
      for (const { child } of workers) if (child.exitCode === null) child.kill()
    }
  })

  it('does not regenerate a missing installation key for migrated metadata or import', () => {
    const { root, path, state, file } = fixture()
    file.read()
    state.close()
    const key = join(root, 'state', 'state-store.key')
    unlinkSync(key)
    const reopened = new KalaStateStore(join(root, 'state'))
    const next = new SettingsFile(path, reopened, { kind: 'models', id: 'catalog' }, (value) => value as { label: string })
    try {
      expect(() => next.read()).toThrow('settings_integrity_key_missing')
      expect(() => next.import({ label: 'not a key reset' })).toThrow('settings_integrity_key_missing')
      expect(existsSync(key)).toBe(false)
    } finally { reopened.close() }
  })
})
