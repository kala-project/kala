import { randomUUID } from 'node:crypto'

import type { AuthenticatedIdentity } from '../assignments/store.js'
import type { ControlPlaneDatabase, SqlExecutor } from '../persistence/postgres.js'
import { OrganizationProvisioningService } from '../organizations/provisioning.js'
import { DEDICATED_OWNER_ISSUER, DEDICATED_OWNER_SUBJECT } from './dedicated-owner.js'

type Owner = { principal_id: string; organization_id: string; runtime_unit_id: string; issuer: string; subject: string }

export class DedicatedOidcOwnerService {
  constructor(private readonly database: ControlPlaneDatabase) {}

  async bootstrap(identity: AuthenticatedIdentity, organizationName: string): Promise<{ organizationId: string; runtimeUnitId: string }> {
    validateIdentity(identity)
    return this.database.transaction(async (transaction) => {
      await lock(transaction)
      if ((await transaction.query('SELECT id FROM organizations LIMIT 1')).rowCount !== 0) {
        throw new Error('Dedicated OIDC bootstrap requires an empty control plane; use explicit Owner binding for an existing installation')
      }
      const provisioned = await new OrganizationProvisioningService(this.database).provisionInTransaction(transaction, {
        operationId: `dedicated-oidc-bootstrap:${randomUUID()}`, name: organizationName,
        owner: { issuer: DEDICATED_OWNER_ISSUER, subject: DEDICATED_OWNER_SUBJECT, displayName: 'Owner' },
        contractReference: 'dedicated-oidc-owner', supportTier: 'standard',
        startsAt: new Date(0), endsAt: new Date('9999-12-31T23:59:59.000Z'),
        seatLimit: 1, concurrentSessionLimit: 100, workspaceLimit: 100,
      })
      const owner = await readOwner(transaction)
      await bind(transaction, owner, identity)
      return { organizationId: provisioned.organizationId, runtimeUnitId: provisioned.runtimeUnitId }
    })
  }

  async verify(identity: AuthenticatedIdentity): Promise<{ organizationId: string; runtimeUnitId: string }> {
    validateIdentity(identity)
    return this.database.transaction(async (transaction) => {
      await lock(transaction)
      const owner = await readOwner(transaction)
      const binding = await transaction.query('SELECT principal_id FROM dedicated_oidc_owner_bindings WHERE principal_id=$1 AND issuer=$2 AND subject=$3',
        [owner.principal_id, identity.issuer, identity.subject])
      if (binding.rowCount !== 1) throw new Error('Dedicated OIDC Owner identity does not match')
      return { organizationId: owner.organization_id, runtimeUnitId: owner.runtime_unit_id }
    })
  }

  async resolveIdentity(identity: AuthenticatedIdentity): Promise<AuthenticatedIdentity | undefined> {
    const result = await this.database.query<{ issuer: string; subject: string; display_name: string | null; email: string | null }>(`
      SELECT p.issuer,p.subject,p.display_name,p.email FROM dedicated_oidc_owner_bindings b
      JOIN principals p ON p.id=b.principal_id
      JOIN organization_memberships m ON m.principal_id=p.id AND m.organization_id=b.organization_id
      WHERE b.issuer=$1 AND b.subject=$2 AND m.status='active' AND m.role='owner'
        AND (SELECT count(*) FROM organizations)=1`, [identity.issuer, identity.subject])
    const row = result.rows[0]
    if (!row) return undefined
    const displayName = identity.displayName || row.display_name
    const email = identity.email || row.email
    return { issuer: row.issuer, subject: row.subject,
      ...(displayName ? { displayName } : {}),
      ...(identity.username ? { username: identity.username } : {}),
      ...(email ? { email } : {}) }
  }

  async bindExisting(input: {
    identity: AuthenticatedIdentity
    expectedOrganizationId: string
    expectedPrincipalId: string
  }): Promise<{ organizationId: string; runtimeUnitId: string; alreadyBound: boolean }> {
    validateIdentity(input.identity)
    return this.database.transaction(async (transaction) => {
      await lock(transaction)
      const owner = await readOwner(transaction)
      if (owner.organization_id !== input.expectedOrganizationId || owner.principal_id !== input.expectedPrincipalId) {
        throw new Error('Existing Dedicated Owner does not match the explicitly selected Organization and principal')
      }
      const prior = await transaction.query<{ issuer: string; subject: string; principal_id: string; organization_id: string }>(
        'SELECT issuer,subject,principal_id,organization_id FROM dedicated_oidc_owner_bindings WHERE singleton=true')
      if (prior.rows[0]) {
        if (prior.rows[0].principal_id !== owner.principal_id || prior.rows[0].organization_id !== owner.organization_id) {
          throw new Error('Existing OIDC binding does not belong to the selected Owner')
        }
        if (prior.rows[0].issuer !== input.identity.issuer || prior.rows[0].subject !== input.identity.subject) {
          throw new Error('Dedicated Owner is already bound to another external identity')
        }
        return { organizationId: owner.organization_id, runtimeUnitId: owner.runtime_unit_id, alreadyBound: true }
      }
      if (owner.issuer !== DEDICATED_OWNER_ISSUER || owner.subject !== DEDICATED_OWNER_SUBJECT) {
        throw new Error('Dedicated Owner is already bound to another external identity')
      }
      await bind(transaction, owner, input.identity)
      await transaction.query('UPDATE dedicated_owner_credentials SET disabled_at=now() WHERE principal_id=$1 AND disabled_at IS NULL', [owner.principal_id])
      await transaction.query(`UPDATE browser_sessions SET revoked_at=now(),revocation_reason='administrator'
        WHERE organization_id=$1 AND revoked_at IS NULL`, [owner.organization_id])
      await transaction.query('UPDATE organizations SET authorization_version=authorization_version+1,updated_at=now() WHERE id=$1', [owner.organization_id])
      await transaction.query(`INSERT INTO audit_events(id,organization_id,actor_principal_id,actor_kind,action,target_type,target_id,result,metadata)
        VALUES($1,$2,$3,'human','dedicated.owner_oidc_bound','principal',$3,'succeeded',$4)`,
      [`aud_${randomUUID()}`, owner.organization_id, owner.principal_id, { issuer: input.identity.issuer, subject: input.identity.subject }])
      return { organizationId: owner.organization_id, runtimeUnitId: owner.runtime_unit_id, alreadyBound: false }
    })
  }
}

async function bind(transaction: SqlExecutor, owner: Owner, identity: AuthenticatedIdentity): Promise<void> {
  const collision = await transaction.query('SELECT id FROM principals WHERE issuer=$1 AND subject=$2', [identity.issuer, identity.subject])
  if (collision.rowCount !== 0) throw new Error('OIDC identity already belongs to another principal; automatic account merging is forbidden')
  await transaction.query(`INSERT INTO dedicated_oidc_owner_bindings(singleton,principal_id,organization_id,issuer,subject)
    VALUES(true,$1,$2,$3,$4)`, [owner.principal_id, owner.organization_id, identity.issuer, identity.subject])
}

async function lock(transaction: SqlExecutor): Promise<void> {
  await transaction.query("SELECT pg_advisory_xact_lock(hashtextextended('kala-dedicated-owner-bootstrap', 0))")
}

async function readOwner(transaction: SqlExecutor): Promise<Owner> {
  const result = await transaction.query<Owner>(`SELECT p.id AS principal_id,o.id AS organization_id,o.runtime_unit_id,p.issuer,p.subject
    FROM organizations o JOIN organization_memberships m ON m.organization_id=o.id
    JOIN principals p ON p.id=m.principal_id
    WHERE o.status='active' AND m.status='active' AND m.role='owner' AND p.kind='human'
      AND (SELECT count(*) FROM organizations)=1
      AND EXISTS (SELECT 1 FROM contract_entitlements e WHERE e.organization_id=o.id AND e.starts_at<=now() AND e.ends_at>now())
    FOR UPDATE OF o,m,p`)
  if (result.rowCount !== 1 || !result.rows[0]) throw new Error('Dedicated requires exactly one active Organization and Owner with an active contract')
  return result.rows[0]
}

function validateIdentity(identity: AuthenticatedIdentity): void {
  const issuer = new URL(identity.issuer)
  if (!['https:', 'http:'].includes(issuer.protocol) || issuer.username || issuer.password || issuer.search || issuer.hash
    || identity.issuer !== issuer.href.replace(/\/$/u, '') || !identity.subject.trim()
    || identity.subject.length > 512 || /[\u0000-\u001f\u007f]/u.test(identity.subject)) {
    throw new Error('Explicit canonical OIDC issuer and subject are required')
  }
}
