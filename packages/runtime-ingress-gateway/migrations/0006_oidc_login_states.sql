-- Shared, short-lived OIDC authorization state for horizontally scaled Gateways.
CREATE TABLE oidc_login_states (
  nonce text PRIMARY KEY CHECK (char_length(nonce) BETWEEN 1 AND 1024),
  code_verifier text NOT NULL CHECK (char_length(code_verifier) BETWEEN 1 AND 1024),
  state text NOT NULL CHECK (char_length(state) BETWEEN 1 AND 1024),
  oidc_nonce text,
  redirect_uri text NOT NULL CHECK (char_length(redirect_uri) BETWEEN 1 AND 4096),
  expires_at timestamptz NOT NULL,
  sso_connection_id text,
  organization_invite_hash text,
  owner_bootstrap_hash text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > created_at)
);
CREATE INDEX oidc_login_states_expiry_idx ON oidc_login_states(expires_at);
