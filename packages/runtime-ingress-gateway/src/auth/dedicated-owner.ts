import { randomBytes, scrypt as nodeScrypt, timingSafeEqual } from 'node:crypto'
import type { AuthenticatedIdentity } from '../assignments/store.js'
import type { ControlPlaneDatabase, SqlExecutor } from '../persistence/postgres.js'
import { OrganizationProvisioningService } from '../organizations/provisioning.js'

export const DEDICATED_OWNER_ISSUER = 'urn:kala:dedicated-owner'
export const DEDICATED_OWNER_SUBJECT = 'owner'

export type DedicatedOwnerAuthentication = {
  identity: AuthenticatedIdentity
  organizationId: string
}

export interface DedicatedOwnerAuthenticator {
  authenticate(password: string): Promise<DedicatedOwnerAuthentication | undefined>
}

type ScryptParameters = { N: number; r: number; p: number; keyLength: number; maxmem: number }
const PRODUCTION_SCRYPT: ScryptParameters = { N: 131_072, r: 8, p: 1, keyLength: 32, maxmem: 256 * 1024 * 1024 }

type CredentialRow = {
  principal_id: string
  organization_id: string
  password_algorithm: 'scrypt'
  password_salt: string
  password_hash: string
  scrypt_n: number
  scrypt_r: number
  scrypt_p: number
  disabled_at: Date | null
  display_name: string | null
  email: string | null
}

export class PostgresDedicatedOwnerAuthenticator implements DedicatedOwnerAuthenticator {
  constructor(private readonly database: SqlExecutor) {}

  async authenticate(password: string): Promise<DedicatedOwnerAuthentication | undefined> {
    if (!validPasswordShape(password)) return undefined
    const result = await this.database.query<CredentialRow>(`SELECT c.principal_id,c.organization_id,c.password_algorithm,c.password_salt,c.password_hash,
      c.scrypt_n,c.scrypt_r,c.scrypt_p,c.disabled_at,p.display_name,p.email
      FROM dedicated_owner_credentials c JOIN principals p ON p.id=c.principal_id
      WHERE c.singleton=true`)
    const credential = result.rows[0]
    if (!credential || credential.disabled_at || credential.password_algorithm !== 'scrypt') return undefined
    const expected = decodeCanonicalBase64url(credential.password_hash)
    const salt = decodeCanonicalBase64url(credential.password_salt)
    if (!expected || !salt || expected.length !== 32 || salt.length < 16) return undefined
    const actual = await derive(password, salt, {
      N: credential.scrypt_n,
      r: credential.scrypt_r,
      p: credential.scrypt_p,
      keyLength: expected.length,
      maxmem: scryptMaxmem(credential.scrypt_n, credential.scrypt_r),
    })
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return undefined
    await this.database.query('UPDATE dedicated_owner_credentials SET last_authenticated_at=now() WHERE singleton=true AND disabled_at IS NULL')
    return {
      organizationId: credential.organization_id,
      identity: {
        issuer: DEDICATED_OWNER_ISSUER,
        subject: DEDICATED_OWNER_SUBJECT,
        displayName: credential.display_name ?? 'Owner',
        ...(credential.email ? { email: credential.email } : {}),
      },
    }
  }
}

export class DedicatedOwnerBootstrapService {
  private readonly provisioning: OrganizationProvisioningService

  constructor(
    private readonly database: ControlPlaneDatabase,
    private readonly parameters: ScryptParameters = PRODUCTION_SCRYPT,
  ) {
    this.provisioning = new OrganizationProvisioningService(database)
    validateParameters(parameters)
  }

  /** Explicit continuation only: authenticate existing authority, never create/reset it. */
  async verifyExisting(input: { password: string; organizationName: string; ownerEmail?: string }): Promise<{ organizationId: string; runtimeUnitId: string }> {
    const expectedEmail = normalizeOptionalEmail(input.ownerEmail)
    return this.database.transaction(async (transaction) => {
      await transaction.query("SELECT pg_advisory_xact_lock(hashtextextended('kala-dedicated-owner-bootstrap', 0))")
      const existing = await transaction.query<{ organization_id: string; runtime_unit_id: string; name: string; email: string | null }>(`
        SELECT c.organization_id,o.runtime_unit_id,o.name,p.email
        FROM dedicated_owner_credentials c
        JOIN principals p ON p.id=c.principal_id
        JOIN organizations o ON o.id=c.organization_id
        JOIN organization_memberships m ON m.organization_id=o.id AND m.principal_id=p.id
        JOIN contract_entitlements e ON e.organization_id=o.id
        WHERE c.singleton=true AND c.disabled_at IS NULL
          AND p.kind='human' AND p.issuer=$1 AND p.subject=$2
          AND o.status='active' AND m.status='active' AND m.role='owner'
          AND e.starts_at <= now() AND e.ends_at > now()
          AND (SELECT count(*) FROM organizations)=1
        FOR UPDATE OF c,p,o,m,e`, [DEDICATED_OWNER_ISSUER, DEDICATED_OWNER_SUBJECT])
      const row = existing.rows[0]
      if (existing.rowCount !== 1 || !row || row.name !== input.organizationName.trim()
        || (expectedEmail !== undefined && row.email !== expectedEmail)) {
        throw new Error('Existing Dedicated Owner/Organization does not match the expected active installation')
      }
      const authenticated = await new PostgresDedicatedOwnerAuthenticator(transaction).authenticate(input.password)
      if (!authenticated || authenticated.organizationId !== row.organization_id) {
        throw new Error('Existing Dedicated Owner does not match the protected password; no credentials were changed')
      }
      return { organizationId: row.organization_id, runtimeUnitId: row.runtime_unit_id }
    })
  }

  async bootstrap(input: { password: string; organizationName: string; ownerEmail?: string }): Promise<{ organizationId: string; runtimeUnitId: string }> {
    assertStrongPassword(input.password)
    const organizationName = input.organizationName.trim()
    if (!organizationName || organizationName.length > 200) throw new Error('invalid Dedicated organization name')
    const ownerEmail = normalizeOptionalEmail(input.ownerEmail)
    const salt = randomBytes(24)
    const hash = await derive(input.password, salt, this.parameters)
    const identity: AuthenticatedIdentity = {
      issuer: DEDICATED_OWNER_ISSUER,
      subject: DEDICATED_OWNER_SUBJECT,
      displayName: 'Owner',
      ...(ownerEmail ? { email: ownerEmail } : {}),
    }
    return this.database.transaction(async (transaction) => {
      await transaction.query("SELECT pg_advisory_xact_lock(hashtextextended('kala-dedicated-owner-bootstrap', 0))")
      const existingCredential = await transaction.query('SELECT singleton FROM dedicated_owner_credentials WHERE singleton=true')
      if (existingCredential.rowCount !== 0) throw new Error('Dedicated Owner is already bootstrapped')
      const existingOrganizations = await transaction.query('SELECT id FROM organizations LIMIT 1')
      if (existingOrganizations.rowCount !== 0) throw new Error('Dedicated bootstrap requires an empty control plane')
      const provisioned = await this.provisioning.provisionInTransaction(transaction, {
        operationId: `dedicated-owner-bootstrap:${randomBytes(16).toString('base64url')}`,
        name: organizationName,
        owner: identity,
        contractReference: 'dedicated-local-owner',
        supportTier: 'standard',
        startsAt: new Date(0),
        endsAt: new Date('9999-12-31T23:59:59.000Z'),
        seatLimit: 1,
        concurrentSessionLimit: 100,
        workspaceLimit: 100,
      })
      const principal = await transaction.query<{ id: string }>('SELECT id FROM principals WHERE issuer=$1 AND subject=$2', [identity.issuer, identity.subject])
      if (!principal.rows[0]) throw new Error('Dedicated Owner principal was not provisioned')
      await transaction.query(`INSERT INTO dedicated_owner_credentials(singleton,principal_id,organization_id,password_algorithm,password_salt,password_hash,scrypt_n,scrypt_r,scrypt_p)
        VALUES(true,$1,$2,'scrypt',$3,$4,$5,$6,$7)`, [
        principal.rows[0].id,
        provisioned.organizationId,
        salt.toString('base64url'),
        hash.toString('base64url'),
        this.parameters.N,
        this.parameters.r,
        this.parameters.p,
      ])
      return { organizationId: provisioned.organizationId, runtimeUnitId: provisioned.runtimeUnitId }
    })
  }
}

async function derive(password: string, salt: Buffer, parameters: ScryptParameters): Promise<Buffer> {
  return await new Promise<Buffer>((resolve, reject) => {
    nodeScrypt(password, salt, parameters.keyLength, {
      N: parameters.N,
      r: parameters.r,
      p: parameters.p,
      maxmem: parameters.maxmem,
    }, (error, key) => { if (error) reject(error); else resolve(key) })
  })
}

function validPasswordShape(password: string): boolean {
  return typeof password === 'string' && Buffer.byteLength(password, 'utf8') >= 12 && Buffer.byteLength(password, 'utf8') <= 1024
}

function assertStrongPassword(password: string): void {
  if (!validPasswordShape(password) || password.length < 14) throw new Error('Dedicated Owner password must contain at least 14 characters and at most 1024 bytes')
}

function normalizeOptionalEmail(value?: string): string | undefined {
  const normalized = value?.trim().toLowerCase()
  if (!normalized) return undefined
  if (normalized.length > 320 || !/^[^\s@]+@[^\s@]+$/u.test(normalized)) throw new Error('invalid Dedicated Owner email')
  return normalized
}

function validateParameters(parameters: ScryptParameters): void {
  if (!Number.isSafeInteger(parameters.N) || parameters.N < 16_384 || (parameters.N & (parameters.N - 1)) !== 0
    || !Number.isSafeInteger(parameters.r) || parameters.r < 8
    || !Number.isSafeInteger(parameters.p) || parameters.p < 1
    || parameters.keyLength !== 32
    || parameters.maxmem < scryptMaxmem(parameters.N, parameters.r)) throw new Error('invalid scrypt parameters')
}

function scryptMaxmem(N: number, r: number): number {
  if (!Number.isSafeInteger(N) || N < 16_384 || N > 1_048_576 || (N & (N - 1)) !== 0 || !Number.isSafeInteger(r) || r < 8 || r > 32) {
    throw new Error('stored scrypt parameters are invalid')
  }
  return Math.max(32 * 1024 * 1024, 256 * N * r)
}

function decodeCanonicalBase64url(value: string): Buffer | undefined {
  try {
    const decoded = Buffer.from(value, 'base64url')
    return decoded.toString('base64url') === value ? decoded : undefined
  } catch { return undefined }
}
