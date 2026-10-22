import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { promisify } from 'node:util'

import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { ServiceAccountService } from '../api/service-accounts.js'
import { inviteKey } from '../assignments/store.js'
import type { SqlExecutor } from '../persistence/postgres.js'
import { PostgresOrganizationStore } from './postgres-store.js'

const { Pool } = pg
const docker = promisify(execFile)
const integrationDescribe = process.env.KALA_RUN_POSTGRES_INTEGRATION === '1' ? describe : describe.skip

integrationDescribe('Private Cloud contract authorization on real PostgreSQL', () => {
  const id = randomUUID()
  const container = `kala-contract-${id}`
  const password = randomUUID()
  let pool: InstanceType<typeof Pool>
  let organizations: PostgresOrganizationStore
  let serviceAccounts: ServiceAccountService
  const owner = { issuer: 'https://identity.example', subject: 'owner', email: 'owner@example.test', emailVerified: true }
  const invite = 'invalid-invite-contract-test'
  const accountToken = 'ak_sa_contract-test'

  beforeAll(async () => {
    await docker('docker', ['run', '--detach', '--rm', '--name', container,
      '--label', `dev.kala.test.project=${id}`,
      '--tmpfs', '/var/lib/postgresql/data:rw,noexec,nosuid,size=256m',
      '--env', `POSTGRES_PASSWORD=${password}`, '--publish', '127.0.0.1::5432', 'postgres:16-alpine'])
    const { stdout } = await docker('docker', ['inspect', '--format', '{{(index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort}}', container])
    pool = new Pool({ connectionString: `postgresql://postgres:${password}@127.0.0.1:${stdout.trim()}/postgres` })
    for (let attempt = 0; attempt < 60; attempt++) {
      try { await pool.query('SELECT 1'); break } catch (error) {
        if (attempt === 59) throw error
        await new Promise((resolve) => setTimeout(resolve, 250))
      }
    }
    for (const migration of ['0001_control_plane.sql', '0002_service_accounts_webhooks.sql']) {
      await pool.query(await readFile(new URL(`../../migrations/${migration}`, import.meta.url), 'utf8'))
    }
    await pool.query(`INSERT INTO organizations(id,name,status,runtime_unit_id) VALUES('org_contract','Contract test','active','tenant_contract')`)
    await pool.query(`INSERT INTO principals(id,kind,issuer,subject,email) VALUES('prn_owner','human',$1,$2,$3),('prn_service','service_account',NULL,NULL,NULL)`, [owner.issuer, owner.subject, owner.email])
    await pool.query(`INSERT INTO organization_memberships(organization_id,principal_id,role) VALUES('org_contract','prn_owner','owner')`)
    await pool.query(`INSERT INTO executor_pools(id,organization_id,name,mode) VALUES('pool_contract','org_contract','Organization pool','organization')`)
    await pool.query(`INSERT INTO executor_enrollment_tokens(id,organization_id,pool_id,token_hash,created_by,expires_at)
      VALUES('enr_contract','org_contract','pool_contract',$1,'prn_owner',now()+interval '1 day')`, [inviteKey(invite)])
    await pool.query(`INSERT INTO service_account_tokens(id,organization_id,principal_id,token_hash,scopes,expires_at)
      VALUES('sat_contract','org_contract','prn_service',$1,ARRAY['workspace:read'],now()+interval '1 day')`, [createHash('sha256').update(accountToken).digest('hex')])
    const database = {
      query: (text: string, values?: readonly unknown[]) => pool.query(text, values as unknown[] | undefined),
      transaction: async <T>(operation: (transaction: SqlExecutor) => Promise<T>): Promise<T> => {
        const client = await pool.connect()
        try { await client.query('BEGIN'); const result = await operation({ query: (text, values) => client.query(text, values as unknown[] | undefined) }); await client.query('COMMIT'); return result }
        catch (error) { await client.query('ROLLBACK'); throw error }
        finally { client.release() }
      },
    }
    organizations = new PostgresOrganizationStore(database)
    serviceAccounts = new ServiceAccountService(database)
  }, 120_000)

  afterAll(async () => {
    await pool?.end().catch(() => undefined)
    await docker('docker', ['rm', '--force', container]).catch(() => undefined)
    const { stdout } = await docker('docker', ['ps', '--all', '--quiet', '--filter', `label=dev.kala.test.project=${id}`])
    expect(stdout.trim()).toBe('')
  }, 30_000)

  it('denies all three principals before start, at expiry, during grace, and without a contract; renewal restores access', async () => {
    const state = async () => ({
      human: (await organizations.findAccess(owner))?.organization.status,
      service: (await serviceAccounts.authenticate(accountToken))?.organizationStatus,
      executor: await organizations.findUnitByExecutorInvite(invite),
    })
    const inactive = { human: 'expired', service: 'expired', executor: undefined }
    const active = { human: 'active', service: 'active', executor: 'tenant_contract' }
    // No entitlement row is not an implicit unlimited contract.
    expect(await state()).toEqual(inactive)
    await pool.query(`INSERT INTO contract_entitlements(organization_id,contract_reference,support_tier,starts_at,ends_at,grace_ends_at,seat_limit,concurrent_session_limit)
      VALUES('org_contract','contract-test','standard',now()+interval '1 hour',now()+interval '2 hours',now()+interval '3 hours',2,2)`)
    expect(await state()).toEqual(inactive)
    await pool.query(`UPDATE contract_entitlements SET starts_at=now()-interval '1 day' WHERE organization_id='org_contract'`)
    expect(await state()).toEqual(active)
    const invitation = await organizations.createInvite('org_contract', owner, 'new@example.test', 'member', new Date(Date.now() + 60_000).toISOString())
    await organizations.bindExecutorInvite('ak_invite_second', 'tenant_contract')
    expect(await organizations.findUnitByExecutorInvite('ak_invite_second')).toBe('tenant_contract')
    await pool.query(`UPDATE contract_entitlements SET ends_at=now() WHERE organization_id='org_contract'`)
    expect(await state()).toEqual(inactive)
    await pool.query(`UPDATE contract_entitlements SET ends_at=now()-interval '1 hour' WHERE organization_id='org_contract'`)
    expect(await state()).toEqual(inactive) // grace_ends_at is still in the future
    await expect(organizations.createInvite('org_contract', owner, 'new@example.test', 'member', new Date(Date.now()+60_000).toISOString()))
      .rejects.toThrow('invite_creator_not_authorized')
    await expect(organizations.bindExecutorInvite('ak_invite_other', 'tenant_contract')).rejects.toThrow('organization not found')
    await expect(organizations.acceptInvite(inviteKey(invitation.token), { issuer: owner.issuer, subject: 'new', email: 'new@example.test', emailVerified: true }))
      .rejects.toThrow('organization_not_active')
    expect(await organizations.findUnitByExecutorInvite('ak_invite_second')).toBeUndefined()
    await pool.query(`UPDATE contract_entitlements SET ends_at=now()+interval '1 hour' WHERE organization_id='org_contract'`)
    expect(await state()).toEqual(active)
    await pool.query(`UPDATE organizations SET status='suspended' WHERE id='org_contract'`)
    expect(await state()).toEqual({ human: 'suspended', service: 'suspended', executor: undefined })
  })
})
