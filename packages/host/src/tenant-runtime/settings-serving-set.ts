import type { ConfigurationRead, SettingsSectionValue } from '@agent-kernel/shared'
import { randomUUID } from 'node:crypto'
import type { HotStateDatabase } from './postgres-hot-state.js'
import type { RuntimeUnitReplicaMembership } from './postgres-runtime-resource-ownership.js'

export type SettingsConsumerSnapshot = {
  revision: string | null
  synchronization: 'ready' | 'synchronizing' | 'disconnected'
  loadedSessions?: number
  pendingSessions?: number
}

/** Reuses existing serving membership; observations never create or extend a lease. */
export class PostgresSettingsServingSet {
  private readonly observerId = randomUUID()
  private sequence = 0
  private readonly resources = new Map<string, Promise<void>>()
  constructor(private readonly options: {
    database: HotStateDatabase; organizationId: string; unitId: string;
    membership(): RuntimeUnitReplicaMembership | undefined;
  }) {}

  private async installed() {
    return (await this.options.database.query<{ installed: boolean }>(
      "SELECT to_regclass('settings_resource_consumer_observations') IS NOT NULL AS installed")).rows[0]?.installed === true
  }

  async publish(resource: { kind: string; id: string }, snapshot: SettingsConsumerSnapshot): Promise<boolean> {
    const sequence = ++this.sequence
    const lease = this.options.membership()
    if (!lease || lease.organizationId !== this.options.organizationId || lease.unitId !== this.options.unitId || !await this.installed()) return false
    const key = JSON.stringify([resource, lease.replicaId, lease.generation.toString()])
    if (!this.resources.has(key)) {
      const initialization = this.options.database.query(`INSERT INTO settings_resource_consumer_observations
        (organization_id,unit_id,resource_kind,resource_id,replica_id,generation,observer_id,observation_sequence,synchronization)
        SELECT organization_id,unit_id,$4,$5,replica_id,generation,$6,0,'synchronizing'
        FROM tenant_runtime_unit_replica_memberships WHERE organization_id=$1 AND unit_id=$2 AND replica_id=$3
          AND generation=$7 AND membership_token=$8 AND origin=$9 AND expires_at>clock_timestamp()
        ON CONFLICT(organization_id,unit_id,resource_kind,resource_id,replica_id,generation) DO UPDATE SET
          observer_id=EXCLUDED.observer_id,observation_sequence=0,revision=NULL,synchronization='synchronizing',observed_at=clock_timestamp()`,
      [this.options.organizationId, this.options.unitId, lease.replicaId, resource.kind, resource.id, this.observerId,
        lease.generation.toString(), lease.membershipToken, lease.origin]).then(() => undefined)
      this.resources.set(key, initialization)
      void initialization.catch(() => { if (this.resources.get(key) === initialization) this.resources.delete(key) })
    }
    await this.resources.get(key)
    const result = await this.options.database.query(`INSERT INTO settings_resource_consumer_observations
      (organization_id,unit_id,resource_kind,resource_id,replica_id,generation,revision,synchronization,details,observer_id,observation_sequence)
      SELECT organization_id,unit_id,$4,$5,replica_id,generation,$6,$7,$8::jsonb,$12,$13
      FROM tenant_runtime_unit_replica_memberships WHERE organization_id=$1 AND unit_id=$2 AND replica_id=$3
        AND generation=$9 AND membership_token=$10 AND origin=$11 AND expires_at>clock_timestamp()
      ON CONFLICT(organization_id,unit_id,resource_kind,resource_id,replica_id,generation) DO UPDATE SET
        revision=EXCLUDED.revision,synchronization=EXCLUDED.synchronization,details=EXCLUDED.details,
        observation_sequence=EXCLUDED.observation_sequence,observed_at=clock_timestamp()
      WHERE settings_resource_consumer_observations.observer_id=EXCLUDED.observer_id
        AND settings_resource_consumer_observations.observation_sequence<EXCLUDED.observation_sequence`,
    [this.options.organizationId, this.options.unitId, lease.replicaId, resource.kind, resource.id, snapshot.revision,
      snapshot.synchronization, JSON.stringify({ ...(snapshot.loadedSessions !== undefined ? { loadedSessions: snapshot.loadedSessions } : {}),
        ...(snapshot.pendingSessions !== undefined ? { pendingSessions: snapshot.pendingSessions } : {}) }),
      lease.generation.toString(), lease.membershipToken, lease.origin, this.observerId, sequence])
    return result.rowCount === 1
  }

  async application(resource: { kind: string; id: string }, revision: string,
    applyMode: ConfigurationRead<SettingsSectionValue>['application']['applyMode']): Promise<ConfigurationRead<SettingsSectionValue>['application']> {
    const base = { desiredRevision: revision, effectiveRevision: null, applyMode, scope: 'unit' as const }
    if (!await this.installed()) return { ...base, state: 'unknown', reasonCode: 'serving_consumer_schema_unavailable', observations: [] }
    const members = (await this.options.database.query<{ replica_id: string; generation: string; revision: string | null;
      synchronization: 'ready' | 'synchronizing' | 'disconnected' | null; observed_at: Date | null; current: boolean }>(
      `SELECT m.replica_id,m.generation::text,c.revision,c.synchronization,c.observed_at,
        coalesce(c.observed_at>=m.updated_at,false) AS current
       FROM tenant_runtime_unit_replica_memberships m LEFT JOIN settings_resource_consumer_observations c
         ON c.organization_id=m.organization_id AND c.unit_id=m.unit_id AND c.replica_id=m.replica_id AND c.generation=m.generation
         AND c.resource_kind=$3 AND c.resource_id=$4
       WHERE m.organization_id=$1 AND m.unit_id=$2 AND m.expires_at>clock_timestamp()
       ORDER BY m.replica_id COLLATE "C"`, [this.options.organizationId, this.options.unitId, resource.kind, resource.id])).rows
    const unknown = !members.length || members.some(member => !member.current || !member.synchronization || member.synchronization === 'disconnected')
    const applied = !unknown && members.every(member => member.synchronization === 'ready' && member.revision === revision)
    return { ...base, state: unknown ? 'unknown' : applied ? 'applied' : 'pending',
      effectiveRevision: applied ? revision : null,
      reasonCode: applied ? 'all_current_serving_consumers_observed' : 'current_serving_consumers_not_converged',
      observations: members.map(member => ({ unitId: this.options.unitId, replicaId: member.replica_id,
        generation: member.generation, revision: member.current ? member.revision : null,
        observedAt: member.observed_at?.toISOString() ?? new Date(0).toISOString(),
        synchronization: !member.current ? 'synchronizing' : member.synchronization ?? 'synchronizing' })) }
  }
}
