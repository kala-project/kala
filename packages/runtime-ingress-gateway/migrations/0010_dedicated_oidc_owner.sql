CREATE TABLE dedicated_oidc_owner_bindings (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  principal_id text NOT NULL UNIQUE REFERENCES principals(id) ON DELETE RESTRICT,
  organization_id text NOT NULL UNIQUE REFERENCES organizations(id) ON DELETE RESTRICT,
  issuer text NOT NULL CHECK (char_length(issuer) BETWEEN 1 AND 2048),
  subject text NOT NULL CHECK (char_length(subject) BETWEEN 1 AND 512),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (issuer, subject),
  FOREIGN KEY (organization_id, principal_id)
    REFERENCES organization_memberships(organization_id, principal_id) ON DELETE RESTRICT
);
