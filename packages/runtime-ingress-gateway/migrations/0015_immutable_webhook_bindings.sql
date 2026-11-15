CREATE FUNCTION valid_organization_webhook_reference(reference text, organization text)
RETURNS boolean LANGUAGE sql IMMUTABLE STRICT SET search_path = pg_catalog AS $function$
  SELECT organization ~ '^[A-Za-z0-9_-]{1,128}$'
    AND reference !~ '[[:space:][:cntrl:]]'
    AND reference ~ ('^bao:organizations/' || organization || '/webhooks(/[A-Za-z0-9_-][A-Za-z0-9_.-]{0,127}){1,13}#[A-Za-z0-9_-][A-Za-z0-9_.-]{0,127}$')
$function$;

CREATE TABLE organization_webhook_secret_bindings (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  label text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 200 AND label = btrim(label)),
  secret_ref text NOT NULL,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, secret_ref),
  CHECK (public.valid_organization_webhook_reference(secret_ref, organization_id))
);

CREATE FUNCTION preserve_webhook_binding_identity() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $function$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
    OR NEW.secret_ref IS DISTINCT FROM OLD.secret_ref THEN
    RAISE EXCEPTION 'immutable_webhook_binding' USING ERRCODE = '23514';
  END IF;
  NEW.revision := OLD.revision + 1;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END $function$;
CREATE TRIGGER immutable_webhook_binding BEFORE UPDATE ON organization_webhook_secret_bindings
  FOR EACH ROW EXECUTE FUNCTION preserve_webhook_binding_identity();

ALTER TABLE webhook_endpoints ADD COLUMN secret_binding_id text;
ALTER TABLE webhook_endpoints ADD COLUMN configuration_error text
  CHECK (configuration_error IS NULL OR configuration_error = 'invalid_secret_reference');
ALTER TABLE webhook_endpoints ADD CONSTRAINT webhook_endpoint_binding_tenant
  FOREIGN KEY (organization_id, secret_binding_id)
  REFERENCES organization_webhook_secret_bindings(organization_id, id) ON DELETE RESTRICT;

WITH valid_references AS (
  SELECT DISTINCT organization_id, secret_ref->>'ref' AS reference
  FROM webhook_endpoints
  WHERE jsonb_typeof(secret_ref) = 'object'
    AND jsonb_typeof(secret_ref->'ref') = 'string'
    AND public.valid_organization_webhook_reference(secret_ref->>'ref', organization_id)
)
INSERT INTO organization_webhook_secret_bindings(id, organization_id, label, secret_ref)
  SELECT 'whb_' || gen_random_uuid()::text, organization_id, 'Imported signing key', reference
  FROM valid_references;

-- Binding backfill does not change the original reference or delivery generation.
UPDATE webhook_endpoints endpoint SET secret_binding_id = binding.id
  FROM organization_webhook_secret_bindings binding
  WHERE endpoint.organization_id = binding.organization_id
    AND jsonb_typeof(endpoint.secret_ref) = 'object'
    AND jsonb_typeof(endpoint.secret_ref->'ref') = 'string'
    AND endpoint.secret_ref->>'ref' = binding.secret_ref;
UPDATE webhook_endpoints SET enabled = false, configuration_error = 'invalid_secret_reference'
  WHERE secret_binding_id IS NULL;

ALTER TABLE webhook_endpoints ADD COLUMN revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0);

CREATE FUNCTION enforce_webhook_binding_snapshot() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $function$
DECLARE
  reference text;
BEGIN
  IF NEW.secret_binding_id IS NOT NULL THEN
    SELECT secret_ref INTO reference FROM public.organization_webhook_secret_bindings
      WHERE organization_id = NEW.organization_id AND id = NEW.secret_binding_id;
    IF reference IS NULL OR NEW.secret_ref->>'ref' IS DISTINCT FROM reference THEN
      RAISE EXCEPTION 'webhook_binding_snapshot_mismatch' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $function$;
CREATE TRIGGER webhook_binding_snapshot BEFORE INSERT OR UPDATE ON webhook_endpoints
  FOR EACH ROW EXECUTE FUNCTION enforce_webhook_binding_snapshot();

CREATE OR REPLACE FUNCTION advance_webhook_endpoint_generation() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public AS $function$
BEGIN
  NEW.delivery_generation := OLD.delivery_generation + CASE WHEN
    NEW.enabled IS DISTINCT FROM OLD.enabled OR NEW.url IS DISTINCT FROM OLD.url
    OR NEW.secret_ref IS DISTINCT FROM OLD.secret_ref
    OR NEW.secret_binding_id IS DISTINCT FROM OLD.secret_binding_id THEN 1 ELSE 0 END;
  NEW.revision := OLD.revision + 1;
  RETURN NEW;
END $function$;

CREATE FUNCTION enforce_webhook_endpoint_limit() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $function$
DECLARE
  must_check boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    must_check := NEW.enabled;
  ELSE
    IF NEW.id IS DISTINCT FROM OLD.id OR NEW.organization_id IS DISTINCT FROM OLD.organization_id THEN
      RAISE EXCEPTION 'immutable_webhook_endpoint' USING ERRCODE = '23514';
    END IF;
    must_check := NEW.enabled AND (NOT OLD.enabled OR NEW.topics IS DISTINCT FROM OLD.topics);
  END IF;
  IF must_check THEN
    PERFORM 1 FROM public.organizations WHERE id = NEW.organization_id FOR UPDATE;
    IF (SELECT count(*) FROM public.webhook_endpoints
      WHERE organization_id = NEW.organization_id AND enabled AND id <> NEW.id) >= 100 THEN
      RAISE EXCEPTION 'webhook_endpoint_limit_exceeded' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $function$;
CREATE TRIGGER webhook_endpoint_limit BEFORE INSERT OR UPDATE ON webhook_endpoints
  FOR EACH ROW EXECUTE FUNCTION enforce_webhook_endpoint_limit();
