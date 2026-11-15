export function operationalSettingsSchemaStatements(schema: string): readonly string[] {
  return [
    `CREATE TABLE IF NOT EXISTS ${schema}.settings_workspace_maintenance_holds (
      operation_id uuid PRIMARY KEY, installation_id uuid NOT NULL, organization_id text NOT NULL,
      unit_id text NOT NULL, workspace_id text NOT NULL, reference_revision text NOT NULL,
      reference_snapshot jsonb NOT NULL, state text NOT NULL CHECK(state IN ('held','committed')),
      resulting_revision bigint, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      completed_at timestamptz, CHECK((state='held' AND resulting_revision IS NULL AND completed_at IS NULL)
        OR (state='committed' AND resulting_revision>0 AND completed_at IS NOT NULL))
    )`,
    `CREATE UNIQUE INDEX settings_workspace_maintenance_one_unit_hold
      ON ${schema}.settings_workspace_maintenance_holds(organization_id,unit_id) WHERE state='held'`,
    `CREATE TABLE IF NOT EXISTS ${schema}.settings_workspace_admissions (
      organization_id text NOT NULL, unit_id text NOT NULL, workspace_id text NOT NULL,
      revision bigint NOT NULL CHECK(revision>0), status text NOT NULL CHECK(status IN ('active','archived')),
      operation_id uuid NOT NULL, observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY(organization_id,workspace_id)
    )`,
    `CREATE TABLE IF NOT EXISTS ${schema}.settings_resource_consumer_observations (
      organization_id text NOT NULL, unit_id text NOT NULL, resource_kind text NOT NULL,
      resource_id text NOT NULL, replica_id text NOT NULL, generation bigint NOT NULL CHECK(generation>0),
      observer_id uuid NOT NULL, observation_sequence bigint NOT NULL CHECK(observation_sequence>=0),
      revision text, synchronization text NOT NULL CHECK(synchronization IN ('ready','synchronizing','disconnected')),
      observed_at timestamptz NOT NULL DEFAULT clock_timestamp(), details jsonb NOT NULL DEFAULT '{}'::jsonb,
      PRIMARY KEY(organization_id,unit_id,resource_kind,resource_id,replica_id,generation)
    )`,
    `CREATE FUNCTION ${schema}.kala_settings_guard_unit_maintenance() RETURNS trigger LANGUAGE plpgsql
      SET search_path = pg_catalog, ${schema} AS $body$
      BEGIN
        IF TG_TABLE_NAME='tenant_runtime_unit_materializations' THEN
          IF NEW.desired_state='suspended' AND (TG_OP='INSERT' OR NEW.organization_id IS NOT DISTINCT FROM OLD.organization_id)
            THEN RETURN NEW; END IF;
        ELSE
          IF NEW.expires_at<=clock_timestamp() THEN RETURN NEW; END IF;
          PERFORM 1 FROM ${schema}.tenant_runtime_unit_materializations WHERE unit_id=NEW.unit_id FOR SHARE;
        END IF;
        IF EXISTS(SELECT 1 FROM ${schema}.settings_workspace_maintenance_holds WHERE unit_id=NEW.unit_id AND state='held') THEN
          RAISE EXCEPTION 'workspace_maintenance_held' USING ERRCODE='55000';
        END IF;
        RETURN NEW;
      END $body$`,
    `CREATE TRIGGER kala_settings_guard_unit_maintenance BEFORE INSERT OR UPDATE
      ON ${schema}.tenant_runtime_unit_materializations FOR EACH ROW EXECUTE FUNCTION ${schema}.kala_settings_guard_unit_maintenance()`,
    `CREATE TRIGGER kala_settings_guard_replica_maintenance BEFORE INSERT OR UPDATE
      ON ${schema}.tenant_runtime_unit_replica_memberships FOR EACH ROW EXECUTE FUNCTION ${schema}.kala_settings_guard_unit_maintenance()`,
    `CREATE FUNCTION ${schema}.kala_settings_guard_workspace_admission() RETURNS trigger LANGUAGE plpgsql
      SET search_path = pg_catalog, ${schema} AS $body$
      DECLARE tenant text; workspace text;
      BEGIN
        IF TG_TABLE_NAME='tenant_session_latest_projection' THEN
          tenant:=NEW.tenant_id; workspace:=NEW.document->>'workspaceId';
        ELSE tenant:=NEW.organization_id; workspace:=NEW.workspace_id; END IF;
        IF workspace IS NULL OR workspace='' THEN RETURN NEW; END IF;
        PERFORM pg_advisory_xact_lock_shared(hashtextextended('kala:workspace-admission:'||tenant||':'||workspace,0));
        IF TG_TABLE_NAME='tenant_session_latest_projection' THEN
          IF NEW.document->'state'->>'status' IN ('done','error') THEN RETURN NEW; END IF;
        END IF;
        IF EXISTS(SELECT 1 FROM ${schema}.settings_workspace_maintenance_holds
            WHERE organization_id=tenant AND workspace_id=workspace AND state='held')
          OR EXISTS(SELECT 1 FROM ${schema}.settings_workspace_admissions
            WHERE organization_id=tenant AND workspace_id=workspace AND status='archived') THEN
          RAISE EXCEPTION 'workspace_admission_denied' USING ERRCODE='55000';
        END IF;
        RETURN NEW;
      END $body$`,
    `CREATE TRIGGER kala_settings_guard_session_workspace BEFORE INSERT OR UPDATE
      ON ${schema}.tenant_session_latest_projection FOR EACH ROW EXECUTE FUNCTION ${schema}.kala_settings_guard_workspace_admission()`,
    `CREATE TRIGGER kala_settings_guard_effect_workspace BEFORE INSERT OR UPDATE
      ON ${schema}.tenant_runtime_active_workspace_effects FOR EACH ROW EXECUTE FUNCTION ${schema}.kala_settings_guard_workspace_admission()`,
    `REVOKE ALL ON FUNCTION ${schema}.kala_settings_guard_unit_maintenance() FROM PUBLIC`,
    `REVOKE ALL ON FUNCTION ${schema}.kala_settings_guard_workspace_admission() FROM PUBLIC`,
  ]
}
