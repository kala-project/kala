SELECT pg_advisory_xact_lock(hashtextextended('kala:control-settings-schema:v1', 0));

CREATE TABLE settings_resource_versions (
  organization_id text NOT NULL REFERENCES organizations(id),
  resource_kind text NOT NULL,
  resource_id text NOT NULL,
  revision bigint NOT NULL CHECK (revision > 0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, resource_kind, resource_id)
);

INSERT INTO settings_resource_versions (organization_id, resource_kind, resource_id, revision)
  SELECT id, 'policy', 'attachment', 1 FROM organizations;
