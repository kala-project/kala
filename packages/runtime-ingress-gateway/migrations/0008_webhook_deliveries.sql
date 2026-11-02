-- Expand only. Stop legacy webhook workers before applying this migration.
-- Existing unresolved events have no trustworthy per-recipient delivery history.
ALTER TABLE outbox_events ADD COLUMN webhook_fanout_state text NOT NULL DEFAULT 'legacy_review'
  CHECK (webhook_fanout_state IN ('pending', 'complete', 'legacy_review', 'blocked'));
ALTER TABLE outbox_events ADD COLUMN webhook_fanout_error text;
ALTER TABLE outbox_events ADD COLUMN webhook_materialized_at timestamptz;
UPDATE outbox_events SET webhook_fanout_state = 'complete'
  WHERE delivered_at IS NOT NULL OR dead_lettered_at IS NOT NULL;
ALTER TABLE outbox_events ALTER COLUMN webhook_fanout_state SET DEFAULT 'pending';
CREATE INDEX outbox_events_webhook_fanout_idx ON outbox_events(occurred_at, id)
  WHERE webhook_fanout_state = 'pending';

-- Do not allow application deletion of an Organization to erase its event ledger.
ALTER TABLE outbox_events DROP CONSTRAINT outbox_events_organization_id_fkey;
ALTER TABLE outbox_events ADD CONSTRAINT outbox_events_organization_id_fkey
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE RESTRICT;
ALTER TABLE outbox_events ADD CONSTRAINT outbox_events_tenant_event_key UNIQUE (id, organization_id);
ALTER TABLE webhook_endpoints ADD CONSTRAINT webhook_endpoints_tenant_key UNIQUE (id, organization_id);

-- Durable invalidation survives disable/re-enable and URL/reference A -> B -> A.
ALTER TABLE webhook_endpoints ADD COLUMN delivery_generation bigint NOT NULL DEFAULT 1 CHECK (delivery_generation > 0);
CREATE FUNCTION advance_webhook_endpoint_generation() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog,public AS $function$
BEGIN
  NEW.delivery_generation := OLD.delivery_generation + CASE WHEN
    NEW.enabled IS DISTINCT FROM OLD.enabled OR NEW.url IS DISTINCT FROM OLD.url
    OR NEW.secret_ref IS DISTINCT FROM OLD.secret_ref THEN 1 ELSE 0 END;
  RETURN NEW;
END $function$;
CREATE TRIGGER webhook_endpoint_generation BEFORE UPDATE ON webhook_endpoints
  FOR EACH ROW EXECUTE FUNCTION advance_webhook_endpoint_generation();

CREATE TABLE webhook_deliveries (
  event_id text NOT NULL,
  endpoint_id text NOT NULL,
  organization_id text NOT NULL,
  endpoint_generation bigint NOT NULL DEFAULT 1 CHECK (endpoint_generation > 0),
  destination_url text NOT NULL,
  secret_ref jsonb NOT NULL CHECK (jsonb_typeof(secret_ref) = 'object'),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'inflight', 'delivered', 'dead', 'cancelled')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_token uuid,
  lease_generation bigint NOT NULL DEFAULT 0 CHECK (lease_generation >= 0),
  lease_expires_at timestamptz,
  last_error text CHECK (last_error IS NULL OR last_error IN (
    'request_failed', 'delivery_timeout', 'secret_unavailable', 'destination_rejected',
    'payload_rejected', 'http_rejected', 'attempts_exhausted', 'endpoint_changed', 'worker_stopping'
  )),
  last_status integer CHECK (last_status BETWEEN 100 AND 599),
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, endpoint_id),
  FOREIGN KEY (event_id, organization_id) REFERENCES outbox_events(id, organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (endpoint_id, organization_id) REFERENCES webhook_endpoints(id, organization_id) ON DELETE RESTRICT,
  CHECK ((state = 'inflight' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR (state <> 'inflight' AND lease_token IS NULL AND lease_expires_at IS NULL))
);
CREATE INDEX webhook_deliveries_ready_idx ON webhook_deliveries(available_at, event_id, endpoint_id)
  WHERE state IN ('pending', 'inflight');

COMMENT ON TABLE webhook_deliveries IS
  'Per-endpoint at-least-once delivery; stable identity, expiring fenced claims, no network in claim transactions';
COMMENT ON COLUMN outbox_events.webhook_fanout_state IS
  'legacy_review requires explicit operator evidence before replay; old workers must stay stopped';
