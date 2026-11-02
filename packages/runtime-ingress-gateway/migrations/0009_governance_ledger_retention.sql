-- Stop/drain legacy retention schedulers before expansion. Old audit outcomes
-- cannot be reconstructed; this protects attribution and immutability forward.
ALTER TABLE usage_ledger DROP CONSTRAINT usage_ledger_workspace_id_fkey;
ALTER TABLE usage_ledger ADD CONSTRAINT usage_ledger_tenant_workspace_fkey
  FOREIGN KEY (organization_id,workspace_id) REFERENCES workspaces(organization_id,id) ON DELETE RESTRICT;
ALTER TABLE usage_ledger DROP CONSTRAINT usage_ledger_principal_id_fkey;
ALTER TABLE usage_ledger ADD CONSTRAINT usage_ledger_principal_id_fkey
  FOREIGN KEY (principal_id) REFERENCES principals(id) ON DELETE RESTRICT;
ALTER TABLE audit_events DROP CONSTRAINT audit_events_actor_principal_id_fkey;
ALTER TABLE audit_events ADD CONSTRAINT audit_events_actor_principal_id_fkey
  FOREIGN KEY (actor_principal_id) REFERENCES principals(id) ON DELETE RESTRICT;
ALTER TABLE audit_events ADD CONSTRAINT audit_events_tenant_event_key UNIQUE(organization_id,id);

CREATE FUNCTION reject_governance_ledger_mutation() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $function$
BEGIN
  RAISE EXCEPTION 'Governance ledger records are immutable; use an approved archival lifecycle' USING ERRCODE='42501';
END $function$;
CREATE TRIGGER audit_events_immutable BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION reject_governance_ledger_mutation();
CREATE TRIGGER usage_ledger_immutable BEFORE UPDATE OR DELETE ON usage_ledger
  FOR EACH ROW EXECUTE FUNCTION reject_governance_ledger_mutation();
CREATE TRIGGER audit_events_no_truncate BEFORE TRUNCATE ON audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION reject_governance_ledger_mutation();
CREATE TRIGGER usage_ledger_no_truncate BEFORE TRUNCATE ON usage_ledger
  FOR EACH STATEMENT EXECUTE FUNCTION reject_governance_ledger_mutation();

-- Identity profile fields may change; issuer/subject/kind/id are not a new identity.
CREATE FUNCTION preserve_principal_identity() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $function$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.kind IS DISTINCT FROM OLD.kind
    OR NEW.issuer IS DISTINCT FROM OLD.issuer OR NEW.subject IS DISTINCT FROM OLD.subject THEN
    RAISE EXCEPTION 'Principal identity is immutable' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END $function$;
CREATE TRIGGER principal_identity_immutable BEFORE UPDATE ON principals
  FOR EACH ROW EXECUTE FUNCTION preserve_principal_identity();

CREATE TABLE retention_runs (
  id uuid PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  runtime_unit_id text NOT NULL,
  period_start timestamptz NOT NULL,
  cutoff timestamptz NOT NULL,
  state text NOT NULL CHECK(state IN ('dispatching','succeeded','control_only','unknown')),
  control_sessions integer NOT NULL CHECK(control_sessions>=0),
  control_devices integer NOT NULL CHECK(control_devices>=0),
  host_sessions integer CHECK(host_sessions>=0),
  intent_audit_id text NOT NULL,
  outcome_audit_id text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  UNIQUE(organization_id,period_start),
  CHECK (isfinite(period_start) AND isfinite(cutoff)
    AND period_start=(date_trunc('day',period_start AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') AND cutoff<period_start),
  FOREIGN KEY(organization_id,intent_audit_id) REFERENCES audit_events(organization_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(organization_id,outcome_audit_id) REFERENCES audit_events(organization_id,id) ON DELETE RESTRICT,
  CHECK ((state='dispatching' AND outcome_audit_id IS NULL AND completed_at IS NULL AND host_sessions IS NULL)
    OR (state<>'dispatching' AND outcome_audit_id IS NOT NULL AND completed_at IS NOT NULL
      AND ((state='succeeded' AND host_sessions IS NOT NULL) OR (state IN ('control_only','unknown') AND host_sessions IS NULL))))
);
CREATE UNIQUE INDEX retention_runs_unsettled_org_idx ON retention_runs(organization_id)
  WHERE state IN ('dispatching','unknown');
COMMENT ON TABLE retention_runs IS 'Durable per-Organization UTC-day admission; unresolved external effects block automatic redispatch pending review';
