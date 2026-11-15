CREATE TABLE settings_operator_operations (
  id uuid PRIMARY KEY,
  installation_fingerprint text NOT NULL CHECK (installation_fingerprint ~ '^[a-f0-9]{64}$'),
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  resource_kind text NOT NULL CHECK (resource_kind IN ('model-management','workspace','pool','entitlement','webhook-secret-binding')),
  resource_id text NOT NULL,
  plan_digest text NOT NULL CHECK (plan_digest ~ '^[a-f0-9]{64}$'),
  expected_revision bigint NOT NULL CHECK (expected_revision >= 0),
  resulting_revision bigint CHECK (resulting_revision > 0),
  state text NOT NULL CHECK (state IN ('applying','awaiting_runtime','applied','verified','failed','reverting','reverted')),
  before_value jsonb,
  after_value jsonb,
  effects jsonb NOT NULL CHECK (jsonb_typeof(effects) = 'array'),
  plan_snapshot jsonb NOT NULL CHECK (jsonb_typeof(plan_snapshot) = 'object'),
  linked_operation_id uuid REFERENCES settings_operator_operations(id) ON DELETE RESTRICT,
  reverted_by uuid REFERENCES settings_operator_operations(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  error_code text
);
REVOKE ALL ON settings_operator_operations FROM PUBLIC;

CREATE TABLE organization_model_management (
  organization_id text PRIMARY KEY REFERENCES organizations(id) ON DELETE RESTRICT,
  desired_management text NOT NULL DEFAULT 'operator' CHECK (desired_management IN ('operator','dashboard')),
  desired_revision bigint NOT NULL DEFAULT 1 CHECK (desired_revision > 0),
  effective_management text NOT NULL DEFAULT 'operator' CHECK (effective_management IN ('operator','dashboard')),
  effective_revision bigint NOT NULL DEFAULT 1 CHECK (effective_revision > 0 AND effective_revision <= desired_revision),
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active','preparing','awaiting_runtime','failed')),
  operation_id uuid REFERENCES settings_operator_operations(id) ON DELETE RESTRICT,
  required_serving_scope jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(required_serving_scope) = 'array'),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (state = 'active' OR operation_id IS NOT NULL),
  CHECK (state <> 'active' OR (desired_management = effective_management AND desired_revision = effective_revision))
);
INSERT INTO organization_model_management(organization_id) SELECT id FROM organizations;
REVOKE ALL ON organization_model_management FROM PUBLIC;

ALTER TABLE executor_pools ADD COLUMN settings_revision bigint NOT NULL DEFAULT 1 CHECK (settings_revision > 0);
ALTER TABLE contract_entitlements ADD COLUMN settings_revision bigint NOT NULL DEFAULT 1 CHECK (settings_revision > 0);
ALTER TABLE contract_entitlements ALTER COLUMN seat_limit TYPE bigint;
ALTER TABLE contract_entitlements ALTER COLUMN concurrent_session_limit TYPE bigint;
ALTER TABLE contract_entitlements ALTER COLUMN workspace_limit TYPE bigint;
ALTER TABLE contract_entitlements ADD CONSTRAINT entitlement_safe_integer_limits CHECK (
  seat_limit <= 9007199254740991 AND concurrent_session_limit <= 9007199254740991 AND workspace_limit <= 9007199254740991
);
ALTER TABLE contract_entitlements ALTER COLUMN monthly_token_limit TYPE numeric;
ALTER TABLE contract_entitlements ALTER COLUMN storage_bytes_limit TYPE numeric;
ALTER TABLE contract_entitlements ADD CONSTRAINT entitlement_whole_decimal_limits CHECK (
  (monthly_token_limit IS NULL OR monthly_token_limit = trunc(monthly_token_limit))
  AND (storage_bytes_limit IS NULL OR storage_bytes_limit = trunc(storage_bytes_limit))
);

CREATE FUNCTION advance_operator_resource_revision() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $function$
BEGIN
  IF TG_TABLE_NAME = 'workspaces' THEN
    IF NEW.id IS DISTINCT FROM OLD.id OR NEW.organization_id IS DISTINCT FROM OLD.organization_id THEN
      RAISE EXCEPTION 'immutable_settings_resource' USING ERRCODE = '23514';
    END IF;
    IF NEW.name IS DISTINCT FROM OLD.name OR NEW.status IS DISTINCT FROM OLD.status THEN
      NEW.policy_version := OLD.policy_version + 1;
      NEW.updated_at := clock_timestamp();
    END IF;
  ELSE
    IF NEW.organization_id IS DISTINCT FROM OLD.organization_id THEN
      RAISE EXCEPTION 'immutable_settings_resource' USING ERRCODE = '23514';
    END IF;
    IF TG_TABLE_NAME = 'executor_pools' THEN
      IF NEW.id IS DISTINCT FROM OLD.id THEN
        RAISE EXCEPTION 'immutable_settings_resource' USING ERRCODE = '23514';
      END IF;
    END IF;
    NEW.settings_revision := OLD.settings_revision + 1;
    IF TG_TABLE_NAME = 'contract_entitlements' THEN NEW.updated_at := clock_timestamp(); END IF;
  END IF;
  RETURN NEW;
END $function$;
CREATE TRIGGER operator_workspace_revision BEFORE UPDATE ON workspaces
  FOR EACH ROW EXECUTE FUNCTION advance_operator_resource_revision();
CREATE TRIGGER operator_pool_revision BEFORE UPDATE ON executor_pools
  FOR EACH ROW EXECUTE FUNCTION advance_operator_resource_revision();
CREATE TRIGGER operator_entitlement_revision BEFORE UPDATE ON contract_entitlements
  FOR EACH ROW EXECUTE FUNCTION advance_operator_resource_revision();
