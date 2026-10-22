import { describe, expect, it } from 'vitest'

import type { SqlExecutor, SqlQueryResult } from '../persistence/postgres.js'
import { PostgresRuntimeResourceOwnerResolver } from './postgres-runtime-resource-owner-resolver.js'

const scope = { organizationId: 'org_acme', unitId: 'unit_acme' }
const authority = [{ organization_id: 'org_acme', placement_organization_id: 'org_acme', runtime_unit_id: 'unit_acme' }]

describe('PostgresRuntimeResourceOwnerResolver', () => {
  it('resolves Session and Task owners only after the trusted organization-to-Unit bind', async () => {
    const resources = executor([{ origin: 'https://replica-a.example:8443' }])
    const control = executor(authority)
    const resolver = new PostgresRuntimeResourceOwnerResolver(
      resources, control, new Set(['https://replica-a.example:8443']),
    )

    await expect(resolver.resolveSessionOwner({ ...scope, sessionId: 'session_01' }))
      .resolves.toBe('https://replica-a.example:8443')
    await expect(resolver.resolveTaskOwner({ ...scope, taskId: 'task_01' }))
      .resolves.toBe('https://replica-a.example:8443')

    expect(control.queries[0]).toMatchObject({ values: ['org_acme', 'unit_acme'] })
    expect(control.queries[0]!.sql).toContain('WHERE o.id=$1 AND o.runtime_unit_id=$2')
    expect(resources.queries[0]).toMatchObject({ values: ['org_acme', 'unit_acme', 'session', 'session_01'] })
    expect(resources.queries[1]).toMatchObject({ values: ['org_acme', 'unit_acme', 'task', 'task_01'] })
    expect(resources.queries[0]!.sql).toContain('member.generation = ownership.membership_generation')
    expect(resources.queries[0]!.sql).toContain('member.membership_token = ownership.membership_token')
    expect(resources.queries[0]!.sql).toContain('ownership.expires_at > clock_timestamp()')
    expect(resources.queries[0]!.sql).toContain('member.expires_at > clock_timestamp()')
    expect(resources.queries[0]!.sql).toContain('SELECT member.origin,ownership.replica_id,ownership.generation')
    expect(resources.queries[0]!.sql).not.toContain('SELECT ownership.*')
  })

  it.each([
    {
      name: 'live',
      rows: [{
        document: { sessionId: 'session_01', organizationId: 'org_acme' },
        origin: 'https://replica-a.example',
      }],
      expected: { status: 'live', binding: { origin: 'https://replica-a.example', replicaId: 'replica-a', generation: 1n } },
    },
    {
      name: 'terminal deleting',
      rows: [{
        document: {
          sessionId: 'session_01', organizationId: 'org_acme',
          __kalaSessionDeletion: { requestedAt: '2026-10-22T20:08:31.369Z' },
        },
        origin: 'https://replica-a.example',
      }],
      expected: { status: 'deleting' },
    },
    {
      name: 'relocating without a live owner',
      rows: [{ document: { sessionId: 'session_01', organizationId: 'org_acme' } }],
      expected: { status: 'relocating' },
    },
    { name: 'missing projection', rows: [], expected: { status: 'missing' } },
    { name: 'final-deleted null projection', rows: [{ document: null }], expected: { status: 'missing' } },
  ])('classifies a Session projection as $name', async ({ rows, expected }) => {
    const resources = executor(rows)
    const resolver = new PostgresRuntimeResourceOwnerResolver(
      resources, executor(authority), new Set(['https://replica-a.example']),
    )

    await expect(resolver.resolveSessionRouteState({ ...scope, sessionId: 'session_01' })).resolves.toEqual(expected)
    expect(resources.queries[0]).toMatchObject({ values: ['org_acme', 'unit_acme', 'session_01'] })
    expect(resources.queries[0]!.sql).toContain('LEFT JOIN tenant_runtime_resource_ownerships')
    expect(resources.queries[0]!.sql).toContain('member.generation = ownership.membership_generation')
    expect(resources.queries[0]!.sql).toContain('member.membership_token = ownership.membership_token')
  })

  it.each([
    { name: 'missing control bind', bind: [] },
    { name: 'ambiguous control bind', bind: [...authority, ...authority] },
    {
      name: 'placement organization mismatch',
      bind: [{ organization_id: 'org_acme', placement_organization_id: 'org_other', runtime_unit_id: 'unit_acme' }],
    },
    {
      name: 'organization mismatch',
      bind: [{ organization_id: 'org_other', placement_organization_id: 'org_other', runtime_unit_id: 'unit_acme' }],
    },
    {
      name: 'Unit mismatch',
      bind: [{ organization_id: 'org_acme', placement_organization_id: 'org_acme', runtime_unit_id: 'unit_other' }],
    },
  ])('fails closed before reading resource ownership for $name', async ({ bind }) => {
    const resources = executor([{ origin: 'https://replica-a.example' }])
    const resolver = new PostgresRuntimeResourceOwnerResolver(
      resources, executor(bind), new Set(['https://replica-a.example']),
    )

    await expect(resolver.resolveSessionOwner({ ...scope, sessionId: 'session_01' })).resolves.toBeUndefined()
    expect(resources.queries).toHaveLength(0)
  })

  it.each([
    { name: 'no live owner', owners: [] },
    { name: 'ambiguous owners', owners: [{ origin: 'https://replica-a.example' }, { origin: 'https://replica-a.example' }] },
    { name: 'origin outside allowlist', owners: [{ origin: 'https://replica-b.example' }] },
    { name: 'origin with a path', owners: [{ origin: 'https://replica-a.example/path' }] },
    { name: 'origin with credentials', owners: [{ origin: Object.assign(new URL('https://replica-a.example'), { username: 'user' }).href }] },
  ])('fails closed for $name', async ({ owners }) => {
    const resolver = new PostgresRuntimeResourceOwnerResolver(
      executor(owners), executor(authority), new Set(['https://replica-a.example']),
    )
    await expect(resolver.resolveSessionOwner({ ...scope, sessionId: 'session_01' })).resolves.toBeUndefined()
  })

  it.each([
    { organizationId: '', unitId: 'unit_acme', sessionId: 'session_01' },
    { organizationId: 'acme', unitId: 'unit_acme', sessionId: 'session_01' },
    { organizationId: 'org_acme!', unitId: 'unit_acme', sessionId: 'session_01' },
    { organizationId: 'org_acme', unitId: '', sessionId: 'session_01' },
    { organizationId: 'org_acme', unitId: '../unit_acme', sessionId: 'session_01' },
    { organizationId: 'org_acme', unitId: 'unit/acme', sessionId: 'session_01' },
    { organizationId: 'org_acme', unitId: 'unit_acme', sessionId: '' },
    { organizationId: 'org_acme', unitId: 'unit_acme', sessionId: 'session/acme' },
    { organizationId: 'org_acme', unitId: 'unit_acme', sessionId: 'x'.repeat(129) },
  ])('rejects invalid organization, Unit, and resource IDs without querying PG: %o', async (input) => {
    const resources = executor([{ origin: 'https://replica-a.example' }])
    const control = executor(authority)
    const resolver = new PostgresRuntimeResourceOwnerResolver(
      resources, control, new Set(['https://replica-a.example']),
    )

    await expect(resolver.resolveSessionOwner(input)).resolves.toBeUndefined()
    expect(control.queries).toHaveLength(0)
    expect(resources.queries).toHaveLength(0)
  })

  it('requires a non-empty, exact, canonical HTTP(S) origin allowlist', () => {
    expect(() => new PostgresRuntimeResourceOwnerResolver(executor([]), executor([]), new Set())).toThrow('must not be empty')
    for (const value of [
      'https://replica-a.example/',
      'https://replica-a.example:443',
      'https://replica-a.example/path',
      'file:///tmp/runtime.sock',
      'not an origin',
    ]) {
      expect(() => new PostgresRuntimeResourceOwnerResolver(executor([]), executor([]), new Set([value])))
        .toThrow('exact canonical HTTP(S) origins')
    }
  })
})

type FakeExecutor = SqlExecutor & { queries: Array<{ sql: string; values: readonly unknown[] }> }

function executor(rows: Array<Record<string, unknown>>): FakeExecutor {
  const queries: Array<{ sql: string; values: readonly unknown[] }> = []
  const resultRows = rows.map((row) => 'origin' in row
    ? { replica_id: 'replica-a', generation: '1', ...row }
    : row)
  return {
    queries,
    async query<Row extends Record<string, unknown>>(sql: string, values: readonly unknown[] = []): Promise<SqlQueryResult<Row>> {
      queries.push({ sql, values })
      return { rows: resultRows as Row[], rowCount: resultRows.length, command: 'SELECT', oid: 0, fields: [] }
    },
  }
}
