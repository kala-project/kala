-- Built-in Dedicated Owner authentication. The singleton credential, principal,
-- Organization membership, and browser sessions all remain in control PostgreSQL.
CREATE TABLE dedicated_owner_credentials (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  principal_id text NOT NULL UNIQUE REFERENCES principals(id) ON DELETE RESTRICT,
  organization_id text NOT NULL UNIQUE REFERENCES organizations(id) ON DELETE RESTRICT,
  password_algorithm text NOT NULL CHECK (password_algorithm = 'scrypt'),
  password_salt text NOT NULL CHECK (char_length(password_salt) BETWEEN 22 AND 128),
  password_hash text NOT NULL CHECK (char_length(password_hash) BETWEEN 43 AND 256),
  scrypt_n integer NOT NULL CHECK (scrypt_n >= 16384),
  scrypt_r integer NOT NULL CHECK (scrypt_r >= 8),
  scrypt_p integer NOT NULL CHECK (scrypt_p >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_authenticated_at timestamptz,
  disabled_at timestamptz,
  FOREIGN KEY (organization_id, principal_id)
    REFERENCES organization_memberships(organization_id, principal_id) ON DELETE RESTRICT
);
