import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ServiceAccountService } from '../api/service-accounts.js'
import { assertControlPlaneSchema, createPostgresControlPlaneDatabase, migrateControlPlane, readControlPlaneMigrations, type ControlPlaneDatabase } from '../persistence/postgres.js'
import { PostgresOrganizationStore } from './postgres-store.js'
import { parseSettingsPage } from './settings-view.js'
import { controlSettingsEtag } from '../settings/control-revisions.js'

const docker = promisify(execFile)
const integrationDescribe = process.env.KALA_RUN_POSTGRES_INTEGRATION === '1' ? describe : describe.skip

integrationDescribe('Settings projections and service accounts on isolated real PostgreSQL', () => {
  const container = `kala-settings-${randomUUID()}`
  const password = randomUUID()
  let database: ControlPlaneDatabase
  let store: PostgresOrganizationStore
  beforeAll(async () => {
    await docker('docker', ['run', '--pull', 'never', '--detach', '--rm', '--name', container,
      '--tmpfs', '/var/lib/postgresql/data:rw,noexec,nosuid,size=256m',
      '--env', `POSTGRES_PASSWORD=${password}`, '--publish', '127.0.0.1::5432', 'postgres:16-alpine'])
    const { stdout } = await docker('docker', ['inspect', '--format', '{{(index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort}}', container])
    database = createPostgresControlPlaneDatabase({ connectionString: `postgresql://postgres:${password}@127.0.0.1:${stdout.trim()}/postgres` })
    for (let attempt = 0; ; attempt++) {
      try { await database.query('SELECT 1'); break } catch (error) {
        if (attempt >= 59) throw error
        await new Promise(resolve => setTimeout(resolve, 250))
      }
    }
    const migrations = await readControlPlaneMigrations(new URL('../../migrations', import.meta.url).pathname)
    await migrateControlPlane(database, migrations.slice(0, 12))
    await expect(assertControlPlaneSchema(database, migrations)).resolves.toBe(12)
    await migrateControlPlane(database, migrations.slice(0, 13))
    await expect(assertControlPlaneSchema(database, migrations)).resolves.toBe(13)
    await database.query("INSERT INTO organizations(id,name,status,runtime_unit_id) VALUES('org_bridge13','Bridge fixture','active','unit_bridge13')")
    await database.query("INSERT INTO principals(id,kind,issuer,subject) VALUES('prn_bridge13','human','https://fixture.test','bridge13')")
    const bridge = new PostgresOrganizationStore(database)
    const bridgeActor = { issuer: 'https://fixture.test', subject: 'bridge13' }
    await bridge.updateAttachmentLimit('org_bridge13', 4 * 1024 * 1024, bridgeActor)
    expect(await bridge.attachmentConfiguration('org_bridge13')).toEqual({ value: { maxBytes: 4 * 1024 * 1024 } })
    await migrateControlPlane(database, migrations)
    await expect(assertControlPlaneSchema(database, migrations)).resolves.toBe(17)
    expect(await bridge.attachmentConfiguration('org_bridge13')).toEqual({ revision: '1', value: { maxBytes: 4 * 1024 * 1024 } })
    await bridge.updateAttachmentLimit('org_bridge13', 8 * 1024 * 1024, bridgeActor, { expectedRevision: '1', writeProtocol: 'conditional-required' })
    expect(await bridge.attachmentConfiguration('org_bridge13')).toEqual({ revision: '2', value: { maxBytes: 8 * 1024 * 1024 } })
    for (const suffix of ['a', 'b']) {
      await database.query(`INSERT INTO organizations(id,name,status,runtime_unit_id) VALUES($1,$2,'active',$3)`, [`org_${suffix}`, `Fixture ${suffix}`, `unit_${suffix}`])
      await database.query(`INSERT INTO principals(id,kind,issuer,subject,display_name) VALUES($1,'human','https://fixture.test',$2,$2)`, [`prn_${suffix}`, suffix])
      await database.query(`INSERT INTO organization_memberships(organization_id,principal_id,role,created_at) VALUES($1,$2,'owner','2026-01-01')`, [`org_${suffix}`, `prn_${suffix}`])
      await database.query(`INSERT INTO contract_entitlements(organization_id,contract_reference,support_tier,starts_at,ends_at,seat_limit,concurrent_session_limit)
        VALUES($1,$2,'standard',now()-interval '1 day',now()+interval '1 day',10,10)`, [`org_${suffix}`, `contract_${suffix}`])
      await database.query(`INSERT INTO workspaces(id,organization_id,name) VALUES($1,$2,$3)`, [`ws_${suffix}`, `org_${suffix}`, `Workspace ${suffix}`])
    }
    await database.query(`INSERT INTO principals(id,kind,issuer,subject,display_name) VALUES('prn_member','human','https://fixture.test','member','Member')`)
    await database.query(`INSERT INTO organization_memberships(organization_id,principal_id,role,created_at) VALUES('org_a','prn_member','member','2026-01-01')`)
    await database.query(`INSERT INTO organization_invites(id,organization_id,email_normalized,role,token_hash,created_by,created_at,expires_at)
      VALUES('invite_a','org_a','invited@example.test','member','protected-hash','prn_a','2026-01-01','2099-01-01')`)
    store = new PostgresOrganizationStore(database)
  }, 120_000)
  afterAll(async () => {
    await database?.close()
    await docker('docker', ['rm', '--force', container]).catch(() => undefined)
  }, 30_000)

  it('executes every scoped collection query, isolates organizations and advances combined member/invite cursors', async () => {
    const seen: string[] = []
    let cursor: string | undefined
    do {
      const page = await store.settingsView('org_a', 'members', parseSettingsPage('org_a', 'members', new URLSearchParams({ limit: '1', ...(cursor ? { cursor } : {}) })))
      seen.push(...page.members?.map(member => member.subject) ?? [], ...page.invites?.map(invite => invite.email) ?? [])
      cursor = page.nextCursor
    } while (cursor)
    expect(seen.sort()).toEqual(['a', 'invited@example.test', 'member'])
    expect((await store.settingsView('org_b', 'members', { limit: 50 })).members?.map(member => member.subject)).toEqual(['b'])
    expect((await store.settingsView('org_a', 'workspaces', { limit: 50 })).workspaces?.map(workspace => workspace.id)).toEqual(['ws_a'])
    expect(await store.settingsView('org_a', 'policies', { limit: 50 })).toHaveProperty('attachmentMaxBytes', 2 * 1024 * 1024)
    expect(await store.settingsView('org_a', 'usage', { limit: 50 })).toMatchObject({ usage: { tokens: '0', sessions: 0, entries: 0 } })
    expect(await store.settingsView('org_a', 'sessions', { limit: 50 })).toEqual({ sessions: [] })
    expect(await store.settingsView('org_a', 'audit', { limit: 50 })).toEqual({ audit: [] })
  })

  it('does not drop records sharing a PostgreSQL microsecond timestamp at any scoped collection page boundary', async () => {
    const time = "'2026-01-01T00:00:00.123456Z'::timestamptz"
    await database.query(`INSERT INTO organizations(id,name,status,runtime_unit_id) VALUES('org_cursor','Cursor fixture','active','unit_cursor');
      INSERT INTO principals(id,kind,issuer,subject) SELECT 'prn_cursor_'||n,'human','fixture-cursor',n::text FROM generate_series(1,4) n;
      INSERT INTO organization_memberships(organization_id,principal_id,role,created_at)
        SELECT 'org_cursor','prn_cursor_'||n,CASE WHEN n=1 THEN 'owner' ELSE 'member' END,${time} FROM generate_series(1,4) n;
      INSERT INTO executor_pools(id,organization_id,name,mode,created_at)
        SELECT 'pool_cursor_'||n,'org_cursor','Cursor pool '||n,'organization',${time} FROM generate_series(1,4) n;
      INSERT INTO browser_sessions(id,principal_id,organization_id,token_hash,cache_namespace,device,created_at,last_seen_at,idle_expires_at,absolute_expires_at)
        SELECT 'bs_cursor_'||n,'prn_cursor_1','org_cursor','cursor-token-'||n,'cursor','{}',${time},${time},
          now()+interval '1 day',now()+interval '2 days' FROM generate_series(1,4) n;
      INSERT INTO audit_events(id,organization_id,actor_kind,action,target_type,result,occurred_at)
        SELECT 'cursor_audit_'||n,'org_cursor','system','fixture','fixture','succeeded',${time} FROM generate_series(1,4) n`)
    for (const section of ['members', 'executors', 'sessions', 'audit'] as const) {
      const seen: string[] = []
      let cursor: string | undefined
      do {
        expect(seen.length).toBeLessThan(5)
        const page = await store.settingsView('org_cursor', section,
          parseSettingsPage('org_cursor', section, new URLSearchParams({ limit: '1', ...(cursor ? { cursor } : {}) })))
        seen.push(...page.members?.map(value => value.subject) ?? [], ...page.executorPools?.map(value => value.id) ?? [],
          ...page.sessions?.map(value => value.id) ?? [], ...page.audit?.map(value => value.id) ?? [])
        cursor = page.nextCursor
      } while (cursor)
      expect(seen, section).toHaveLength(4)
      expect(new Set(seen).size, section).toBe(4)
    }
  })

  it('uses the existing locked retention version for conditional writes, audit atomicity and legacy compatibility', async () => {
    await database.query(`INSERT INTO retention_policies(organization_id,session_days,artifact_days,audit_days,deleted_resource_grace_days)
      VALUES ('org_a',30,90,365,30)`)
    const actor = { issuer: 'https://fixture.test', subject: 'a' }
    const policy = { sessionDays: 45, artifactDays: 90, auditDays: 365, deletedResourceGraceDays: 30 }
    const results = await Promise.allSettled([45, 60].map(sessionDays => store.updateRetentionPolicy('org_a',
      { ...policy, sessionDays }, { expectedRevision: '1', actor })))
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.find(result => result.status === 'rejected')).toMatchObject({ reason: { status: 412 } })
    const read = async () => (await database.query('SELECT session_days,version::text FROM retention_policies WHERE organization_id=$1', ['org_a'])).rows[0]
    expect((await read())?.version).toBe('2')
    expect((await database.query("SELECT metadata FROM audit_events WHERE action='organization.retention.update'")).rows).toMatchObject([
      { metadata: { previousRevision: '1', revision: '2', previousSessionDays: 30 } },
    ])
    for (const expectedEtag of ['*', `W/${controlSettingsEtag('org_a', 'retention', '2')}`,
      controlSettingsEtag('org_b', 'retention', '2'), controlSettingsEtag('org_a', 'attachment-policy', '2')]) {
      await expect(store.updateRetentionPolicy('org_a', policy, { expectedEtag, actor })).rejects.toMatchObject({ status: 412 })
    }
    await expect(store.updateRetentionPolicy('org_a', policy, { writeProtocol: 'conditional-required' })).rejects.toMatchObject({ status: 428 })
    await store.updateRetentionPolicy('org_a', policy, { expectedEtag: controlSettingsEtag('org_a', 'retention', '2'), actor })
    expect((await read())?.version).toBe('3')
    await store.updateRetentionPolicy('org_a', policy)
    expect((await read())?.version).toBe('4')
    await database.query(`CREATE FUNCTION settings_audit_failure() RETURNS trigger LANGUAGE plpgsql AS
      'BEGIN RAISE EXCEPTION ''fixture audit failure''; END'`)
    await database.query(`CREATE TRIGGER settings_audit_failure BEFORE INSERT ON audit_events
      FOR EACH ROW EXECUTE FUNCTION settings_audit_failure()`)
    try {
      await expect(store.updateRetentionPolicy('org_a', { ...policy, sessionDays: 90 }, { expectedRevision: '4', actor }))
        .rejects.toThrow('fixture audit failure')
      expect(await read()).toMatchObject({ session_days: 45, version: '4' })
    } finally { await database.query('DROP TRIGGER settings_audit_failure ON audit_events') }
    await database.query("UPDATE retention_policies SET version=9007199254740993 WHERE organization_id='org_a'")
    await store.updateRetentionPolicy('org_a', policy, { expectedRevision: '9007199254740993', actor })
    expect((await read())?.version).toBe('9007199254740994')
  })

  it('serializes attachment CAS, preserves revision tombstones and rolls value/version/audit back together', async () => {
    const actor = { issuer: 'https://fixture.test', subject: 'b' }
    const results = await Promise.allSettled([4, 8].map(size => store.updateAttachmentLimit('org_b',
      size * 1024 * 1024, actor, { expectedRevision: '1' })))
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.find(result => result.status === 'rejected')).toMatchObject({ reason: { status: 412 } })
    const before = await store.attachmentConfiguration('org_b')
    expect(before.revision).toBe('2')
    await expect(store.updateAttachmentLimit('org_b', 16 * 1024 * 1024, actor, {
      expectedEtag: controlSettingsEtag('org_b', 'attachment-policy', '2', 'https://other-installation.test'),
      authority: 'https://this-installation.test',
    })).rejects.toMatchObject({ status: 412 })
    await database.query(`CREATE FUNCTION settings_attachment_audit_failure() RETURNS trigger LANGUAGE plpgsql AS
      'BEGIN RAISE EXCEPTION ''fixture attachment audit failure''; END'`)
    await database.query(`CREATE TRIGGER settings_attachment_audit_failure BEFORE INSERT ON audit_events
      FOR EACH ROW EXECUTE FUNCTION settings_attachment_audit_failure()`)
    try {
      await expect(store.updateAttachmentLimit('org_b', 16 * 1024 * 1024, actor, { expectedRevision: '2' }))
        .rejects.toThrow('fixture attachment audit failure')
      expect(await store.attachmentConfiguration('org_b')).toEqual(before)
    } finally { await database.query('DROP TRIGGER settings_attachment_audit_failure ON audit_events') }
    await store.updateAttachmentLimit('org_b', 16 * 1024 * 1024, actor)
    expect(await store.attachmentConfiguration('org_b')).toEqual({ revision: '3', value: { maxBytes: 16 * 1024 * 1024 } })
  })

  it('serializes a one-account quota across concurrent creations and revokes actual authentication', async () => {
    const service = new ServiceAccountService(database, { maxActiveServiceAccounts: 1 })
    const outcomes = await Promise.allSettled(['first', 'second'].map(name => service.create({ organizationId: 'org_a', name, scopes: ['organization:read'] })))
    expect(outcomes.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(outcomes.filter(result => result.status === 'rejected')).toMatchObject([{ reason: expect.objectContaining({ message: 'service account quota exceeded' }) }])
    const created = outcomes.find(result => result.status === 'fulfilled')
    if (!created || created.status !== 'fulfilled') throw new Error('missing issued account')
    expect(await service.authenticate(created.value.token)).toMatchObject({ organizationId: 'org_a', principalId: created.value.id, scopes: ['organization:read'] })
    const row = await database.query<{ token_hash: string }>('SELECT token_hash FROM service_account_tokens WHERE principal_id=$1', [created.value.id])
    expect(row.rows[0]?.token_hash).not.toBe(created.value.token)
    expect((await database.query("SELECT id FROM principals WHERE kind='service_account'")).rows).toHaveLength(1)
    expect(await service.revoke('org_b', created.value.id)).toBe(false)
    expect(await service.authenticate(created.value.token)).toBeDefined()
    expect(await service.revoke('org_a', created.value.id)).toBe(true)
    expect(await service.authenticate(created.value.token)).toBeUndefined()
  })

  it('pages service-account principal identities without losing rows or crossing organizations', async () => {
    const service = new ServiceAccountService(database)
    await service.create({ organizationId: 'org_b', name: 'one', scopes: ['workspace:read'] })
    await service.create({ organizationId: 'org_b', name: 'two', scopes: ['audit:read'] })
    const first = await service.listPage('org_b', { limit: 1 })
    expect(first.items).toHaveLength(1)
    expect(first.nextCursor).toBeDefined()
    const second = await service.listPage('org_b', parseSettingsPage('org_b', 'service-accounts', new URLSearchParams({ limit: '1', cursor: first.nextCursor! })))
    expect(second.items).toHaveLength(1)
    expect(first.items[0]?.id).not.toBe(second.items[0]?.id)
    expect(second.nextCursor).toBeUndefined()
    expect(JSON.stringify([...first.items, ...second.items])).not.toContain('token')
  })

  it('transfers exactly one same-organization Owner and advances authorization atomically', async () => {
    const owner = { issuer: 'https://fixture.test', subject: 'a' }
    const next = { issuer: owner.issuer, subject: 'member' }
    const version = async () => BigInt((await database.query<{ authorization_version: string }>(
      'SELECT authorization_version FROM organizations WHERE id=$1', ['org_a'],
    )).rows[0]!.authorization_version)
    const before = await version()
    await expect(store.transferOwnership('org_a', owner, { issuer: owner.issuer, subject: 'b' })).rejects.toThrow('active member')
    expect(await version()).toBe(before)
    await store.transferOwnership('org_a', owner, next)
    const roles = await database.query<{ principal_id: string; role: string }>(
      "SELECT principal_id,role FROM organization_memberships WHERE organization_id='org_a' AND status='active' ORDER BY principal_id",
    )
    expect(roles.rows).toEqual([{ principal_id: 'prn_a', role: 'admin' }, { principal_id: 'prn_member', role: 'owner' }])
    expect(await version()).toBe(before + 1n)
    expect((await database.query("SELECT role FROM organization_memberships WHERE organization_id='org_b' AND principal_id='prn_b'")).rows[0]?.role).toBe('owner')
    await expect(store.transferOwnership('org_a', owner, next)).rejects.toThrow('current owner')
    expect(await version()).toBe(before + 1n)
  })
})
