import { createHmac, timingSafeEqual } from 'node:crypto'

export const RUNTIME_ROUTING_TICKET_VERSION = 2 as const
export const RUNTIME_ROUTING_TICKET_SCHEMA = 'kala.runtime-routing-ticket.v2' as const
export const RUNTIME_ROUTING_TICKET_KIND = 'runtime-resource-route' as const
export const RUNTIME_ROUTING_TICKET_KEY_BYTES = 32
export const RUNTIME_ROUTING_TICKET_MAX_LENGTH = 4_096

export type RuntimeRoutingResourceKind = 'session' | 'task'

export type RuntimeRoutingTicketClaims = {
  version: typeof RUNTIME_ROUTING_TICKET_VERSION
  schema: typeof RUNTIME_ROUTING_TICKET_SCHEMA
  kind: typeof RUNTIME_ROUTING_TICKET_KIND
  audience: string
  /** Gateway-canonical authenticated principal (issuer NUL subject, base64url). */
  principalId: string
  organizationId: string
  unitId: string
  resourceKind: RuntimeRoutingResourceKind
  resourceId: string
  ownerReplicaId: string
  /** Positive PostgreSQL bigint encoded as canonical base-10 text. */
  ownerGeneration: string
  /** Integer Unix time in milliseconds. */
  issuedAt: number
  /** Integer Unix time in milliseconds. */
  expiresAt: number
}

export type IssueRuntimeRoutingTicketInput = Omit<RuntimeRoutingTicketClaims, 'version' | 'schema' | 'kind' | 'ownerGeneration' | 'issuedAt' | 'expiresAt'> & {
  ownerGeneration: bigint | string
  ttlMs: number
}

export type RuntimeRoutingTicketIssueOptions = {
  key: Uint8Array
  maxTtlMs: number
  nowMs?: number
}

export type RuntimeRoutingTicketVerifyOptions = {
  key: Uint8Array
  audience: string
  maxTtlMs: number
  nowMs?: number
  /** Bounded tolerance for verifier clocks lagging behind the issuer; defaults to zero. */
  maxFutureSkewMs?: number
}

const CLAIM_KEYS = [
  'audience', 'expiresAt', 'issuedAt', 'kind', 'organizationId', 'ownerGeneration',
  'ownerReplicaId', 'principalId', 'resourceId', 'resourceKind', 'schema', 'unitId', 'version',
] as const
const SAFE_IDENTIFIER = /^[0-9A-Za-z][0-9A-Za-z_.:-]{0,255}$/u
const SAFE_AUDIENCE = /^[0-9A-Za-z][0-9A-Za-z_.:/-]{0,255}$/u
const POSITIVE_BIGINT = /^[1-9][0-9]*$/u
const BASE64URL = /^[A-Za-z0-9_-]+$/u

/**
 * Issues an opaque-to-clients, HMAC-authenticated routing capability. The key is
 * always supplied by the caller; this primitive never reads configuration or
 * generates key material.
 */
export function issueRuntimeRoutingTicket(
  input: IssueRuntimeRoutingTicketInput,
  options: RuntimeRoutingTicketIssueOptions,
): string {
  const key = validateKey(options.key)
  const nowMs = validateNow(options.nowMs ?? Date.now())
  validateMaxTtl(options.maxTtlMs)
  if (!Number.isSafeInteger(input.ttlMs) || input.ttlMs <= 0 || input.ttlMs > options.maxTtlMs) {
    throw new TypeError('routing ticket ttlMs must be a positive integer no greater than maxTtlMs')
  }
  const ownerGeneration = typeof input.ownerGeneration === 'bigint'
    ? input.ownerGeneration.toString(10)
    : input.ownerGeneration
  const claims: RuntimeRoutingTicketClaims = {
    version: RUNTIME_ROUTING_TICKET_VERSION,
    schema: RUNTIME_ROUTING_TICKET_SCHEMA,
    kind: RUNTIME_ROUTING_TICKET_KIND,
    audience: input.audience,
    principalId: input.principalId,
    organizationId: input.organizationId,
    unitId: input.unitId,
    resourceKind: input.resourceKind,
    resourceId: input.resourceId,
    ownerReplicaId: input.ownerReplicaId,
    ownerGeneration,
    issuedAt: nowMs,
    expiresAt: nowMs + input.ttlMs,
  }
  if (!validClaims(claims)) throw new TypeError('routing ticket claims are invalid')
  const payload = encodeBase64Url(Buffer.from(canonicalClaims(claims), 'utf8'))
  const signature = createHmac('sha256', key).update(payload, 'ascii').digest()
  return `${payload}.${encodeBase64Url(signature)}`
}

/**
 * Authenticates and validates a ticket without trusting a parsed field first.
 * Invalid, expired, future-issued, over-TTL, polluted, or non-canonical input
 * fails closed as undefined.
 */
export function verifyRuntimeRoutingTicket(
  ticket: unknown,
  options: RuntimeRoutingTicketVerifyOptions,
): RuntimeRoutingTicketClaims | undefined {
  const key = validateKey(options.key)
  const nowMs = validateNow(options.nowMs ?? Date.now())
  validateMaxTtl(options.maxTtlMs)
  const maxFutureSkewMs = options.maxFutureSkewMs ?? 0
  if (!Number.isSafeInteger(maxFutureSkewMs) || maxFutureSkewMs < 0 || maxFutureSkewMs > 5_000) {
    throw new TypeError('routing ticket maxFutureSkewMs must be between zero and 5000 milliseconds')
  }
  if (typeof ticket !== 'string' || ticket.length === 0 || ticket.length > RUNTIME_ROUTING_TICKET_MAX_LENGTH) return undefined
  const segments = ticket.split('.')
  if (segments.length !== 2) return undefined
  const payload = segments[0] ?? ''
  const suppliedSignature = decodeBase64Url(segments[1] ?? '')
  const expectedSignature = createHmac('sha256', key).update(payload, 'ascii').digest()
  const comparableSignature = suppliedSignature?.length === expectedSignature.length
    ? suppliedSignature
    : Buffer.alloc(expectedSignature.length)
  const signatureMatches = timingSafeEqual(expectedSignature, comparableSignature)
  if (!signatureMatches || suppliedSignature?.length !== expectedSignature.length) return undefined

  const payloadBytes = decodeBase64Url(payload)
  if (!payloadBytes) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(payloadBytes.toString('utf8')) as unknown
  } catch {
    return undefined
  }
  if (!validClaims(parsed)) return undefined
  if (encodeBase64Url(Buffer.from(canonicalClaims(parsed), 'utf8')) !== payload) return undefined
  if (parsed.audience !== options.audience) return undefined
  if (parsed.issuedAt > nowMs + maxFutureSkewMs || parsed.expiresAt <= nowMs) return undefined
  if (parsed.expiresAt - parsed.issuedAt > options.maxTtlMs) return undefined
  return parsed
}

function validClaims(value: unknown): value is RuntimeRoutingTicketClaims {
  if (!isRecord(value)) return false
  const keys = Object.keys(value).sort()
  if (keys.length !== CLAIM_KEYS.length || keys.some((key, index) => key !== CLAIM_KEYS[index])) return false
  return value.version === RUNTIME_ROUTING_TICKET_VERSION
    && value.schema === RUNTIME_ROUTING_TICKET_SCHEMA
    && value.kind === RUNTIME_ROUTING_TICKET_KIND
    && typeof value.audience === 'string' && SAFE_AUDIENCE.test(value.audience)
    && typeof value.principalId === 'string' && SAFE_IDENTIFIER.test(value.principalId)
    && typeof value.organizationId === 'string' && SAFE_IDENTIFIER.test(value.organizationId)
    && typeof value.unitId === 'string' && SAFE_IDENTIFIER.test(value.unitId)
    && (value.resourceKind === 'session' || value.resourceKind === 'task')
    && typeof value.resourceId === 'string' && SAFE_IDENTIFIER.test(value.resourceId)
    && typeof value.ownerReplicaId === 'string' && SAFE_IDENTIFIER.test(value.ownerReplicaId)
    && typeof value.ownerGeneration === 'string' && POSITIVE_BIGINT.test(value.ownerGeneration)
    && typeof value.issuedAt === 'number' && Number.isSafeInteger(value.issuedAt) && value.issuedAt >= 0
    && typeof value.expiresAt === 'number' && Number.isSafeInteger(value.expiresAt) && value.expiresAt > value.issuedAt
}

function canonicalClaims(claims: RuntimeRoutingTicketClaims): string {
  return JSON.stringify({
    audience: claims.audience,
    expiresAt: claims.expiresAt,
    issuedAt: claims.issuedAt,
    kind: claims.kind,
    organizationId: claims.organizationId,
    ownerGeneration: claims.ownerGeneration,
    ownerReplicaId: claims.ownerReplicaId,
    principalId: claims.principalId,
    resourceId: claims.resourceId,
    resourceKind: claims.resourceKind,
    schema: claims.schema,
    unitId: claims.unitId,
    version: claims.version,
  })
}

function validateKey(key: Uint8Array): Uint8Array {
  if (!(key instanceof Uint8Array) || key.byteLength !== RUNTIME_ROUTING_TICKET_KEY_BYTES) {
    throw new TypeError(`routing ticket signing key must contain exactly ${RUNTIME_ROUTING_TICKET_KEY_BYTES} bytes`)
  }
  return key
}

function validateMaxTtl(maxTtlMs: number): void {
  if (!Number.isSafeInteger(maxTtlMs) || maxTtlMs <= 0) throw new TypeError('routing ticket maxTtlMs must be a positive integer')
}

function validateNow(nowMs: number): number {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new TypeError('routing ticket nowMs must be a non-negative integer')
  return nowMs
}

function encodeBase64Url(value: Uint8Array): string {
  return Buffer.from(value).toString('base64url')
}

function decodeBase64Url(value: string): Buffer | undefined {
  if (!BASE64URL.test(value)) return undefined
  try {
    const decoded = Buffer.from(value, 'base64url')
    return encodeBase64Url(decoded) === value ? decoded : undefined
  } catch {
    return undefined
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
