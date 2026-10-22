import { createHash, randomBytes } from 'node:crypto'

import type { AuthenticatedIdentity } from '../assignments/store.js'
import { identityKey, inviteKey } from '../assignments/store.js'

export type OrganizationRole = 'owner' | 'admin' | 'member' | 'viewer'
export type OrganizationPermission = 'runtime:read' | 'runtime:write' | 'workspace:manage' | 'organization:manage' | 'policy:manage'
// `expired` is an effective authorization status, not a persisted organizations.status.
export type OrganizationStatus = 'provisioning' | 'active' | 'expired' | 'suspended' | 'closing' | 'closed'

export type Organization = { id: string; name: string; unitId: string; status: OrganizationStatus; createdAt: string }
export type OrganizationMembership = { organizationId: string; identity: AuthenticatedIdentity; role: OrganizationRole; createdAt: string }
export type OrganizationAccess = { organization: Organization; membership: OrganizationMembership }
export type OrganizationInvite = { id: string; organizationId: string; email: string; role: Exclude<OrganizationRole, 'owner'>; createdAt: string; expiresAt: string; acceptedAt?: string; revokedAt?: string }
export type CreatedOrganizationInvite = { invite: OrganizationInvite; token: string }

export interface OrganizationStore {
  getOrCreateForIdentity(identity: AuthenticatedIdentity): Promise<OrganizationAccess>
  findAccess(identity: AuthenticatedIdentity): Promise<OrganizationAccess | undefined>
  listMembers(organizationId: string): Promise<readonly OrganizationMembership[]>
  addMember(organizationId: string, identity: AuthenticatedIdentity, role: Exclude<OrganizationRole, 'owner'>): Promise<OrganizationMembership>
  updateMemberRole(organizationId: string, identity: AuthenticatedIdentity, role: Exclude<OrganizationRole, 'owner'>): Promise<void>
  removeMember(organizationId: string, identity: AuthenticatedIdentity): Promise<void>
  transferOwnership(organizationId: string, currentOwner: AuthenticatedIdentity, nextOwner: AuthenticatedIdentity): Promise<void>
  createInvite?(organizationId: string, createdBy: AuthenticatedIdentity, email: string, role: Exclude<OrganizationRole, 'owner'>, expiresAt: string): Promise<CreatedOrganizationInvite>
  listInvites?(organizationId: string): Promise<readonly OrganizationInvite[]>
  revokeInvite?(organizationId: string, inviteId: string): Promise<void>
  acceptInvite?(inviteTokenHash: string, identity: AuthenticatedIdentity): Promise<OrganizationAccess>
  bindExecutorInvite(inviteToken: string, unitId: string): Promise<void>
  findUnitByExecutorInvite(inviteToken: string): Promise<string | undefined>
  findUnitByExecutorRouteHint(inviteHash: string): Promise<string | undefined>
  administrationSnapshot?(organizationId: string): Promise<Record<string, unknown>>
  updateRetentionPolicy?(organizationId: string, policy: { sessionDays: number; artifactDays: number; auditDays: number; deletedResourceGraceDays: number }): Promise<void>
}

const ROLE_PERMISSIONS: Record<OrganizationRole, ReadonlySet<OrganizationPermission>> = {
  owner: new Set(['runtime:read', 'runtime:write', 'workspace:manage', 'organization:manage', 'policy:manage']),
  admin: new Set(['runtime:read', 'runtime:write', 'workspace:manage', 'organization:manage', 'policy:manage']),
  member: new Set(['runtime:read', 'runtime:write']),
  viewer: new Set(['runtime:read']),
}

export function permits(role: OrganizationRole, permission: OrganizationPermission): boolean {
  return ROLE_PERMISSIONS[role].has(permission)
}

export class MemoryOrganizationStore implements OrganizationStore {
  protected readonly organizations = new Map<string, Organization>()
  protected readonly memberships = new Map<string, OrganizationMembership>()
  protected readonly executorInviteUnits = new Map<string, string>()
  protected readonly organizationInvites = new Map<string, OrganizationInvite & { tokenHash: string }>()

  async getOrCreateForIdentity(identity: AuthenticatedIdentity): Promise<OrganizationAccess> {
    const existing = await this.findAccess(identity)
    if (existing) return existing
    const opaque = createHash('sha256').update(identityKey(identity)).digest('hex').slice(0, 26)
    const organization: Organization = { id: `org_${opaque}`, unitId: `tenant_${opaque}`, name: identity.displayName?.trim() || 'My organization', status: 'active', createdAt: new Date().toISOString() }
    const membership: OrganizationMembership = { organizationId: organization.id, identity, role: 'owner', createdAt: organization.createdAt }
    this.organizations.set(organization.id, organization)
    this.memberships.set(identityKey(identity), membership)
    return { organization, membership }
  }

  async findAccess(identity: AuthenticatedIdentity): Promise<OrganizationAccess | undefined> {
    const membership = this.memberships.get(identityKey(identity))
    const organization = membership ? this.organizations.get(membership.organizationId) : undefined
    return membership && organization ? { organization, membership } : undefined
  }

  async listMembers(organizationId: string): Promise<readonly OrganizationMembership[]> {
    return [...this.memberships.values()].filter((membership) => membership.organizationId === organizationId)
  }

  async addMember(organizationId: string, identity: AuthenticatedIdentity, role: Exclude<OrganizationRole, 'owner'>): Promise<OrganizationMembership> {
    if (!this.organizations.has(organizationId)) throw new Error('organization not found')
    const key = identityKey(identity)
    const existing = this.memberships.get(key)
    if (existing && existing.organizationId !== organizationId) throw new Error('identity_already_belongs_to_another_organization')
    const membership = { organizationId, identity, role, createdAt: existing?.createdAt ?? new Date().toISOString() }
    this.memberships.set(key, membership)
    return membership
  }

  async updateMemberRole(organizationId: string, identity: AuthenticatedIdentity, role: Exclude<OrganizationRole, 'owner'>): Promise<void> {
    const current = this.memberships.get(identityKey(identity))
    if (!current || current.organizationId !== organizationId || current.role === 'owner') throw new Error('membership not found or immutable')
    this.memberships.set(identityKey(identity), { ...current, role })
  }

  async removeMember(organizationId: string, identity: AuthenticatedIdentity): Promise<void> {
    const key = identityKey(identity); const current = this.memberships.get(key)
    if (!current || current.organizationId !== organizationId || current.role === 'owner') throw new Error('membership not found or immutable')
    this.memberships.delete(key)
  }

  async transferOwnership(organizationId: string, currentOwner: AuthenticatedIdentity, nextOwner: AuthenticatedIdentity): Promise<void> {
    const currentKey = identityKey(currentOwner), nextKey = identityKey(nextOwner)
    const current = this.memberships.get(currentKey), next = this.memberships.get(nextKey)
    if (!current || current.organizationId !== organizationId || current.role !== 'owner') throw new Error('current owner not found')
    if (!next || next.organizationId !== organizationId || next.role === 'owner') throw new Error('next owner must be an active member')
    this.memberships.set(currentKey, { ...current, role: 'admin' })
    this.memberships.set(nextKey, { ...next, role: 'owner' })
  }

  async createInvite(organizationId: string, createdBy: AuthenticatedIdentity, email: string, role: Exclude<OrganizationRole, 'owner'>, expiresAt: string): Promise<CreatedOrganizationInvite> {
    const creator = this.memberships.get(identityKey(createdBy))
    if (!creator || creator.organizationId !== organizationId || !['owner', 'admin'].includes(creator.role)) throw new Error('invite_creator_not_authorized')
    const normalizedEmail = normalizeInviteEmail(email)
    assertInviteExpiration(expiresAt)
    const token = `ak_org_invite_${randomBytes(32).toString('base64url')}`
    const invite: OrganizationInvite = { id: `oinv_${randomBytes(13).toString('hex')}`, organizationId, email: normalizedEmail, role, createdAt: new Date().toISOString(), expiresAt }
    this.organizationInvites.set(invite.id, { ...invite, tokenHash: inviteKey(token) })
    return { invite, token }
  }

  async listInvites(organizationId: string): Promise<readonly OrganizationInvite[]> {
    return [...this.organizationInvites.values()]
      .filter((invite) => invite.organizationId === organizationId)
      .map(({ tokenHash: _tokenHash, ...invite }) => invite)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
  }

  async revokeInvite(organizationId: string, inviteId: string): Promise<void> {
    const invite = this.organizationInvites.get(inviteId)
    if (!invite || invite.organizationId !== organizationId || invite.acceptedAt || invite.revokedAt) throw new Error('invite_not_found')
    this.organizationInvites.set(inviteId, { ...invite, revokedAt: new Date().toISOString() })
  }

  async acceptInvite(inviteTokenHash: string, identity: AuthenticatedIdentity): Promise<OrganizationAccess> {
    const invite = [...this.organizationInvites.values()].find((candidate) => candidate.tokenHash === inviteTokenHash)
    if (!invite || invite.acceptedAt || invite.revokedAt || Date.parse(invite.expiresAt) <= Date.now()) throw new Error('invite_not_available')
    if (!identity.email || identity.emailVerified !== true) throw new Error('invite_verified_email_required')
    if (normalizeInviteEmail(identity.email) !== invite.email) throw new Error('invite_email_mismatch')
    const existing = this.memberships.get(identityKey(identity))
    if (existing && existing.organizationId !== invite.organizationId) throw new Error('identity_already_belongs_to_another_organization')
    const organization = this.organizations.get(invite.organizationId)
    if (!organization || organization.status !== 'active') throw new Error('organization_not_active')
    const membership: OrganizationMembership = { organizationId: invite.organizationId, identity, role: existing?.role === 'owner' ? 'owner' : invite.role, createdAt: existing?.createdAt ?? new Date().toISOString() }
    this.memberships.set(identityKey(identity), membership)
    this.organizationInvites.set(invite.id, { ...invite, acceptedAt: new Date().toISOString() })
    return { organization, membership }
  }

  async bindExecutorInvite(inviteToken: string, unitId: string): Promise<void> { this.executorInviteUnits.set(inviteKey(inviteToken), unitId) }
  async findUnitByExecutorInvite(inviteToken: string): Promise<string | undefined> { return this.findUnitByExecutorRouteHint(inviteKey(inviteToken)) }
  async findUnitByExecutorRouteHint(inviteHash: string): Promise<string | undefined> { return this.executorInviteUnits.get(inviteHash) }
}

export function newOrganizationId(): string { return `org_${randomBytes(13).toString('hex')}` }

export function normalizeInviteEmail(email: string): string {
  const normalized = email.trim().toLowerCase()
  if (normalized.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(normalized)) throw new Error('invalid_invite_email')
  return normalized
}

export function assertInviteExpiration(expiresAt: string): void {
  const value = Date.parse(expiresAt)
  const now = Date.now()
  if (!Number.isFinite(value) || value <= now || value > now + 30 * 86_400_000) throw new Error('invalid_invite_expiration')
}
